import type { Db, Tx } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import type { Permission } from './permissions.js';

export interface Actor {
  userId: string;
  organizationId: string;
}

/** The place a permission is being exercised: organization, entity or location. */
export type Target =
  | { kind: 'organization' }
  | { kind: 'legal_entity'; legalEntityId: string }
  | { kind: 'location'; locationId: string }
  | { kind: 'country'; countryCode: string };

interface ScopeChain {
  countryCode: string | null;
  legalEntityId: string | null;
  locationAncestors: string[];
}

type Q = Db | Tx;

async function resolveChain(q: Q, actor: Actor, target: Target): Promise<ScopeChain> {
  switch (target.kind) {
    case 'organization':
      return { countryCode: null, legalEntityId: null, locationAncestors: [] };
    case 'country':
      return { countryCode: target.countryCode, legalEntityId: null, locationAncestors: [] };
    case 'legal_entity': {
      const { rows } = await q.query<{ country_code: string }>(
        'SELECT country_code FROM legal_entities WHERE id = $1 AND organization_id = $2',
        [target.legalEntityId, actor.organizationId],
      );
      if (!rows[0]) throw notFound('Legal entity');
      return { countryCode: rows[0].country_code, legalEntityId: target.legalEntityId, locationAncestors: [] };
    }
    case 'location': {
      const { rows } = await q.query<{ country_code: string; legal_entity_id: string; ancestor_ids: string[] }>(
        `SELECT l.country_code, l.legal_entity_id, l.ancestor_ids
           FROM locations l JOIN legal_entities e ON e.id = l.legal_entity_id
          WHERE l.id = $1 AND e.organization_id = $2`,
        [target.locationId, actor.organizationId],
      );
      const row = rows[0];
      if (!row) throw notFound('Location');
      return { countryCode: row.country_code, legalEntityId: row.legal_entity_id, locationAncestors: row.ancestor_ids };
    }
  }
}

const ACTIVE_GRANT = `
  FROM memberships m
  JOIN users u ON u.id = m.user_id
  JOIN role_permissions rp ON rp.role_id = m.role_id
 WHERE m.user_id = $1
   AND m.organization_id = $2
   AND u.status = 'active'
   AND rp.permission = $3
   AND m.revoked_at IS NULL
   AND m.valid_from <= now()
   AND (m.valid_until IS NULL OR m.valid_until > now())`;

/**
 * True when the actor holds `permission` through a grant whose scope covers the
 * target. Organization targets are covered only by group-scope grants; use
 * hasPermissionAnywhere for read access to organization-wide data.
 */
export async function can(q: Q, actor: Actor, permission: Permission, target: Target): Promise<boolean> {
  const chain = await resolveChain(q, actor, target);
  const { rowCount } = await q.query(
    `SELECT 1 ${ACTIVE_GRANT}
       AND (
            (m.scope_type = 'group' AND m.scope_id = $2)
         OR (m.scope_type = 'country' AND m.scope_country = $4)
         OR (m.scope_type = 'legal_entity' AND m.scope_id = $5)
         OR (m.scope_type = 'location' AND m.scope_id = ANY($6::uuid[]))
       )
     LIMIT 1`,
    [actor.userId, actor.organizationId, permission, chain.countryCode, chain.legalEntityId, chain.locationAncestors],
  );
  return (rowCount ?? 0) > 0;
}

export async function authorize(q: Q, actor: Actor, permission: Permission, target: Target): Promise<void> {
  if (!(await can(q, actor, permission, target))) throw forbidden();
}

/** For organization-wide shared data (e.g. the catalogue): any active grant of the permission. */
export async function hasPermissionAnywhere(q: Q, actor: Actor, permission: Permission): Promise<boolean> {
  const { rowCount } = await q.query(`SELECT 1 ${ACTIVE_GRANT} LIMIT 1`, [
    actor.userId,
    actor.organizationId,
    permission,
  ]);
  return (rowCount ?? 0) > 0;
}

export async function authorizeAnywhere(q: Q, actor: Actor, permission: Permission): Promise<void> {
  if (!(await hasPermissionAnywhere(q, actor, permission))) throw forbidden();
}

export interface Grants {
  group: boolean;
  countries: Set<string>;
  legalEntities: Set<string>;
  locations: Set<string>;
}

/** The scopes over which the actor holds `permission`, for filtering list queries. */
export async function grantsFor(q: Q, actor: Actor, permission: Permission): Promise<Grants> {
  const { rows } = await q.query<{ scope_type: string; scope_id: string | null; scope_country: string | null }>(
    `SELECT m.scope_type, m.scope_id, m.scope_country ${ACTIVE_GRANT}`,
    [actor.userId, actor.organizationId, permission],
  );
  const g: Grants = { group: false, countries: new Set(), legalEntities: new Set(), locations: new Set() };
  for (const r of rows) {
    if (r.scope_type === 'group') g.group = true;
    else if (r.scope_type === 'country' && r.scope_country) g.countries.add(r.scope_country.trim());
    else if (r.scope_type === 'legal_entity' && r.scope_id) g.legalEntities.add(r.scope_id);
    else if (r.scope_type === 'location' && r.scope_id) g.locations.add(r.scope_id);
  }
  return g;
}

/** The union of scopes over which the actor holds at least one of `permissions`. */
export async function grantsForAny(q: Q, actor: Actor, permissions: readonly Permission[]): Promise<Grants> {
  const merged: Grants = { group: false, countries: new Set(), legalEntities: new Set(), locations: new Set() };
  for (const permission of permissions) {
    const g = await grantsFor(q, actor, permission);
    merged.group ||= g.group;
    for (const c of g.countries) merged.countries.add(c);
    for (const e of g.legalEntities) merged.legalEntities.add(e);
    for (const l of g.locations) merged.locations.add(l);
  }
  return merged;
}
