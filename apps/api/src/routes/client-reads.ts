import type { FastifyPluginAsync } from 'fastify';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { authorize, grantsFor } from '../auth/authorize.js';
import { PERMISSIONS, type Permission } from '../auth/permissions.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import { scopeFilter, uuid } from '../inventory/common.js';

/** Reads that clients need to adapt to the signed-in person and to populate pickers and lists. */
export const clientReadRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  // What this person may do, and over what. A UI uses it to show only what will work; the server still decides.
  app.get('/me/grants', async (req) => {
    const u = await db.query<{ email: string; display_name: string }>('SELECT email, display_name FROM users WHERE id = $1', [req.actor.userId]);
    const { rows } = await db.query<{ permission: string; scope_type: string; scope_id: string | null; scope_country: string | null; role_key: string; valid_until: Date | null }>(
      `SELECT rp.permission, m.scope_type, m.scope_id, m.scope_country, r.key AS role_key, m.valid_until
         FROM memberships m JOIN roles r ON r.id = m.role_id JOIN role_permissions rp ON rp.role_id = r.id
        WHERE m.user_id = $1 AND m.organization_id = $2 AND m.revoked_at IS NULL AND m.valid_from <= now() AND (m.valid_until IS NULL OR m.valid_until > now())
        ORDER BY rp.permission, m.scope_type`,
      [req.actor.userId, req.actor.organizationId],
    );
    const byPermission: Record<string, { scope: string; id?: string; country?: string; role: string }[]> = {};
    for (const r of rows) {
      (byPermission[r.permission] ??= []).push({ scope: r.scope_type, ...(r.scope_id ? { id: r.scope_id } : {}), ...(r.scope_country ? { country: r.scope_country.trim() } : {}), role: r.role_key });
    }
    return { user: { id: req.actor.userId, email: u.rows[0]!.email, displayName: u.rows[0]!.display_name, organizationId: req.actor.organizationId }, permissions: byPermission };
  });

  app.get('/permissions', async () => PERMISSIONS);

  app.get('/users', async (req) => {
    await authorize(db, req.actor, 'iam.manage', { kind: 'organization' });
    const { rows } = await db.query(`SELECT id, email, display_name AS "displayName", status, created_at AS "createdAt" FROM users WHERE organization_id = $1 ORDER BY email`, [req.actor.organizationId]);
    return rows;
  });

  app.get('/roles', async (req) => {
    await authorize(db, req.actor, 'iam.manage', { kind: 'organization' });
    const { rows } = await db.query(
      `SELECT r.id, r.key, r.name, COALESCE(array_agg(rp.permission ORDER BY rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE r.organization_id = $1 GROUP BY r.id ORDER BY r.key`,
      [req.actor.organizationId],
    );
    return rows;
  });

  app.get('/memberships', async (req) => {
    const q = z.object({ userId: uuid.optional(), includeRevoked: z.coerce.boolean().default(false) }).parse(req.query);
    await authorize(db, req.actor, 'iam.manage', { kind: 'organization' });
    const { rows } = await db.query(
      `SELECT m.id, m.user_id AS "userId", u.email, m.role_id AS "roleId", r.key AS "roleKey", m.scope_type AS "scopeType", m.scope_id AS "scopeId",
              trim(m.scope_country) AS "scopeCountry", m.valid_until AS "validUntil", m.revoked_at AS "revokedAt"
         FROM memberships m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
        WHERE m.organization_id = $1 AND ($2::uuid IS NULL OR m.user_id = $2) AND ($3 OR m.revoked_at IS NULL) ORDER BY u.email, m.created_at`,
      [req.actor.organizationId, q.userId ?? null, q.includeRevoked],
    );
    return rows;
  });

  app.get('/pricing/price-lists', async (req) => {
    const grants = await grantsFor(db, req.actor, 'pos.read');
    const { rows } = await db.query<{ legalEntityId: string; countryCode: string }>(
      `SELECT p.id, p.legal_entity_id AS "legalEntityId", e.country_code AS "countryCode", p.name, p.currency
         FROM price_lists p JOIN legal_entities e ON e.id = p.legal_entity_id WHERE p.organization_id = $1 ORDER BY p.name`,
      [req.actor.organizationId],
    );
    return rows.filter((r) => grants.group || grants.countries.has(r.countryCode.trim()) || grants.legalEntities.has(r.legalEntityId)).map(({ countryCode: _c, ...r }) => r);
  });

  app.get('/pos/registers', async (req) => {
    const grants = await grantsFor(db, req.actor, 'pos.read');
    const sell = await grantsFor(db, req.actor, 'pos.sell');
    const scope = scopeFilter({ group: grants.group || sell.group, countries: new Set([...grants.countries, ...sell.countries]), legalEntities: new Set([...grants.legalEntities, ...sell.legalEntities]), locations: new Set([...grants.locations, ...sell.locations]) }, 2);
    const { rows } = await db.query(
      `SELECT r.id, r.code, r.name, r.location_id AS "locationId", r.price_list_id AS "priceListId", r.status, r.max_discount_bps AS "maxDiscountBps",
              pl.currency, c.minor_unit AS "minorUnit",
              (SELECT s.id FROM pos_sessions s WHERE s.register_id = r.id AND s.status = 'open') AS "openSessionId",
              (SELECT s.cashier_id FROM pos_sessions s WHERE s.register_id = r.id AND s.status = 'open') AS "openSessionCashierId"
         FROM pos_registers r JOIN locations l ON l.id = r.location_id JOIN price_lists pl ON pl.id = r.price_list_id JOIN currencies c ON c.code = pl.currency
        WHERE r.organization_id = $1 AND ${scope.clause} ORDER BY r.code`,
      [req.actor.organizationId, ...scope.params],
    );
    return rows;
  });

  // Variants a register can sell right now: current price, tax and what is free at its location. For terminals.
  app.get('/pos/registers/:id/catalog', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const reg = await db.query<{ location_id: string; price_list_id: string }>('SELECT location_id, price_list_id FROM pos_registers WHERE id = $1 AND organization_id = $2', [id, req.actor.organizationId]);
    if (!reg.rows[0]) throw notFound('Register');
    await authorize(db, req.actor, 'pos.sell', { kind: 'location', locationId: reg.rows[0].location_id });
    const { rows } = await db.query(
      `SELECT v.id AS "variantId", v.sku, p.name, p.category, v.tracking, i.unit_price::text AS "unitPrice", t.code AS "taxCode", t.rate::text AS "taxRate",
              COALESCE(t.price_inclusive, false) AS "taxInclusive", u.code AS "unit",
              COALESCE((SELECT sum(b.quantity - b.reserved) FROM stock_balances b WHERE b.variant_id = v.id AND b.location_id = $2 AND b.state = 'on_hand'), 0)::text AS "available"
         FROM product_variants v JOIN products p ON p.id = v.product_id JOIN units u ON u.id = p.base_unit_id
         JOIN price_list_items i ON i.variant_id = v.id AND i.price_list_id = $3 AND i.effective_from <= now() AND (i.effective_to IS NULL OR i.effective_to > now())
         LEFT JOIN tax_codes t ON t.id = i.tax_code_id
        WHERE v.organization_id = $1 AND v.status = 'active' AND p.status = 'active'
          AND ($4::text IS NULL OR p.name ILIKE '%' || $4 || '%' OR v.sku ILIKE '%' || $4 || '%'
               OR EXISTS (SELECT 1 FROM variant_barcodes bc WHERE bc.variant_id = v.id AND bc.barcode = $4))
        ORDER BY p.name, v.sku LIMIT $5`,
      [req.actor.organizationId, reg.rows[0].location_id, reg.rows[0].price_list_id, q.q ?? null, q.limit],
    );
    return rows;
  });

};

/**
 * Development sign-in: mints a token for any existing user so local work and automated browser tests need no identity
 * provider. Registered only outside production and only when a development secret is configured. Production refuses to
 * start with the secret at all (see config), so this route cannot exist there.
 */
export const devAuthRoutes: FastifyPluginAsync<{ db: Db; config: Config }> = async (app, { db, config }) => {
  if (config.NODE_ENV === 'production' || !config.AUTH_DEV_SECRET || !config.DEV_TOKEN_ENDPOINT) return;
  const key = new TextEncoder().encode(config.AUTH_DEV_SECRET);
  app.post('/dev/token', async (req, reply) => {
    const body = z.object({ email: z.string().email() }).parse(req.body);
    const u = await db.query<{ external_subject: string; status: string }>('SELECT external_subject, status FROM users WHERE email = $1 LIMIT 1', [body.email]);
    if (!u.rows[0] || u.rows[0].status !== 'active') return reply.status(404).send({ error: 'not_found', message: 'No active user with that email' });
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(u.rows[0].external_subject).setIssuedAt().setExpirationTime('8h').sign(key);
    return { token, note: 'Development token. Not available in production.' };
  });
};

export type { Permission };
