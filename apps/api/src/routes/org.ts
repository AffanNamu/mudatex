import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { authorize, grantsFor, grantsForAny } from '../auth/authorize.js';
import { withTx, type Db } from '../db.js';
import { notFound } from '../errors.js';

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const country = z.string().regex(/^[A-Z]{2}$/);

const legalEntityBody = z.object({
  name: z.string().min(1).max(200),
  countryCode: country,
  functionalCurrency: z.string().regex(/^[A-Z]{3}$/),
});

const locationBody = z.object({
  legalEntityId: z.string().uuid(),
  parentId: z.string().uuid().optional(),
  type: z.enum(['branch', 'warehouse', 'storage_location', 'department', 'cost_centre']),
  name: z.string().min(1).max(200),
  countryCode: country,
  timezone: z.string().refine(isTimeZone, 'Unknown IANA time zone'),
});

export const orgRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/legal-entities', async (req, reply) => {
    const body = legalEntityBody.parse(req.body);
    const { actor } = req;
    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'org.manage', { kind: 'organization' });
      const { rows } = await tx.query(
        `INSERT INTO legal_entities (organization_id, name, country_code, functional_currency)
         VALUES ($1, $2, $3, $4) RETURNING id, name, country_code AS "countryCode", functional_currency AS "functionalCurrency"`,
        [actor.organizationId, body.name, body.countryCode, body.functionalCurrency],
      );
      await writeAudit(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        requestId: req.id,
        action: 'legal_entity.create',
        entityType: 'legal_entity',
        entityId: rows[0].id,
        after: rows[0],
      });
      return rows[0];
    });
    return reply.status(201).send(created);
  });

  // Anyone who works for a company may see its name, in the scopes they work in.
  app.get('/legal-entities', async (req) => {
    const grants = await grantsForAny(db, req.actor, ['org.read', 'accounting.read', 'accounting.journal', 'pricing.manage', 'procurement.read', 'pos.read', 'inventory.read']);
    const { rows } = await db.query<{ id: string; name: string; countryCode: string; functionalCurrency: string; minorUnit: number }>(
      `SELECT e.id, e.name, e.country_code AS "countryCode", e.functional_currency AS "functionalCurrency", c.minor_unit AS "minorUnit"
         FROM legal_entities e JOIN currencies c ON c.code = e.functional_currency WHERE e.organization_id = $1 ORDER BY e.name`,
      [req.actor.organizationId],
    );
    return rows.filter(
      (e) => grants.group || grants.countries.has(e.countryCode.trim()) || grants.legalEntities.has(e.id),
    );
  });

  app.post('/locations', async (req, reply) => {
    const body = locationBody.parse(req.body);
    const { actor } = req;
    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'org.manage', { kind: 'legal_entity', legalEntityId: body.legalEntityId });

      const id = crypto.randomUUID();
      let ancestors: string[] = [id];
      if (body.parentId) {
        const parent = await tx.query<{ ancestor_ids: string[]; legal_entity_id: string }>(
          'SELECT ancestor_ids, legal_entity_id FROM locations WHERE id = $1',
          [body.parentId],
        );
        const p = parent.rows[0];
        if (!p || p.legal_entity_id !== body.legalEntityId) throw notFound('Parent location');
        ancestors = [...p.ancestor_ids, id];
      }
      const { rows } = await tx.query(
        `INSERT INTO locations (id, legal_entity_id, parent_id, type, name, country_code, timezone, ancestor_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, legal_entity_id AS "legalEntityId", parent_id AS "parentId", type, name, country_code AS "countryCode", timezone`,
        [id, body.legalEntityId, body.parentId ?? null, body.type, body.name, body.countryCode, body.timezone, ancestors],
      );
      await writeAudit(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        requestId: req.id,
        action: 'location.create',
        entityType: 'location',
        entityId: id,
        after: rows[0],
      });
      return rows[0];
    });
    return reply.status(201).send(created);
  });

  // Anyone who works at a place may see its name: the same scopes that let them act there.
  app.get('/locations', async (req) => {
    const grants = await grantsForAny(db, req.actor, ['org.read', 'inventory.read', 'inventory.receive', 'pos.read', 'pos.sell', 'procurement.read', 'manufacturing.read']);
    const { rows } = await db.query<{
      id: string;
      legalEntityId: string;
      parentId: string | null;
      type: string;
      name: string;
      countryCode: string;
      timezone: string;
      ancestorIds: string[];
    }>(
      `SELECT l.id, l.legal_entity_id AS "legalEntityId", l.parent_id AS "parentId", l.type, l.name,
              l.country_code AS "countryCode", l.timezone, l.ancestor_ids AS "ancestorIds"
         FROM locations l JOIN legal_entities e ON e.id = l.legal_entity_id
        WHERE e.organization_id = $1 ORDER BY l.name`,
      [req.actor.organizationId],
    );
    return rows
      .filter(
        (l) =>
          grants.group ||
          grants.countries.has(l.countryCode.trim()) ||
          grants.legalEntities.has(l.legalEntityId) ||
          l.ancestorIds.some((a) => grants.locations.has(a)),
      )
      .map(({ ancestorIds: _ancestors, ...l }) => l);
  });
};
