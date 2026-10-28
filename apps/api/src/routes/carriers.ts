import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, hasPermissionAnywhere } from '../auth/authorize.js';
import { withTx, type Db } from '../db.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../errors.js';
import type { SecretBox } from '../events/secretbox.js';
import { audit, uuid } from '../inventory/common.js';
import type { AdapterRegistry } from '../shipping/adapters.js';
import { CARRIER_COLUMNS, loadCarrier } from '../shipping/booking.js';
import { applyTrackingEvents, newCarrierSecret, SHIPMENT_STATUSES } from '../shipping/service.js';

const statusMap = z.record(z.string().trim().toLowerCase().min(1).max(80), z.enum(SHIPMENT_STATUSES)).refine((m) => Object.keys(m).length <= 100, 'At most 100 entries');
const trackingUrl = z.string().url().max(500).refine((u) => u.startsWith('https://') && u.includes('{ref}'), 'Must start with https:// and contain {ref} where the tracking number goes');

const createBody = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Lower-case letters, digits and dashes'),
  name: z.string().trim().min(2).max(80),
  kind: z.enum(['manual', 'webhook', 'api']),
  trackingUrl: trackingUrl.optional(),
  adapter: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
  statusMap: statusMap.default({}),
  credentials: z.record(z.string().min(1).max(60), z.string().max(2000)).optional(),
});
const updateBody = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  trackingUrl: trackingUrl.nullable().optional(),
  statusMap: statusMap.optional(),
  active: z.boolean().optional(),
  credentials: z.record(z.string().min(1).max(60), z.string().max(2000)).optional(),
});
const eventBody = z.object({
  status: z.enum(SHIPMENT_STATUSES),
  description: z.string().trim().max(300).optional(),
  location: z.string().trim().max(200).optional(),
  occurredAt: z.string().datetime().optional(),
});

const view = (r: { credentialsEncrypted?: string | null; webhookSecretEncrypted?: string | null } & Record<string, unknown>) => {
  const { credentialsEncrypted, webhookSecretEncrypted, ...rest } = r;
  return { ...rest, hasCredentials: !!credentialsEncrypted, hasWebhookSecret: !!webhookSecretEncrypted, webhookPath: `/webhooks/carriers/${r.id}` };
};
const LIST = `${CARRIER_COLUMNS}, webhook_secret_encrypted AS "webhookSecretEncrypted", created_at AS "createdAt"`;

/** The delivery companies the business works with, and the staff's tracking updates for a parcel. */
export const carrierRoutes: FastifyPluginAsync<{ db: Db; secretBox: SecretBox | null; adapters: AdapterRegistry }> = async (app, { db, secretBox, adapters }) => {
  const box = () => {
    if (!secretBox) throw new AppError(503, 'secrets_not_configured', 'Delivery companies need SECRETS_ENCRYPTION_KEY to be set on the server');
    return secretBox;
  };

  app.get('/carriers', async (req) => {
    const { actor } = req;
    if (!(await hasPermissionAnywhere(db, actor, 'carriers.manage')) && !(await hasPermissionAnywhere(db, actor, 'orders.fulfil'))) throw forbidden();
    const { rows } = await db.query(`SELECT ${LIST} FROM carriers WHERE organization_id = $1 ORDER BY active DESC, name`, [actor.organizationId]);
    return rows.map(view);
  });

  /** Which connector modules this installation has, for the "api" kind. */
  app.get('/carrier-adapters', async (req) => {
    await authorize(db, req.actor, 'carriers.manage', { kind: 'organization' });
    return Object.values(adapters).map((a) => ({ key: a.key, books: !!a.book, tracks: !!a.track }));
  });

  app.post('/carriers', async (req, reply) => {
    const body = createBody.parse(req.body);
    await authorize(db, req.actor, 'carriers.manage', { kind: 'organization' });
    if (body.kind === 'api') {
      if (!body.adapter) throw invalid('Choose which connector this delivery company uses');
      if (!adapters[body.adapter]) throw invalid(`No connector named "${body.adapter}" is installed. Connectors are added to Mudatex by its developers once the delivery company's API details are known.`);
    } else if (body.adapter) throw invalid('Only "api" delivery companies use a connector');
    const secret = body.kind === 'webhook' ? newCarrierSecret() : null;
    const created = await withTx(db, async (tx) => {
      try {
        const { rows } = await tx.query(
          `INSERT INTO carriers (organization_id, key, name, kind, tracking_url, adapter, status_map, webhook_secret_encrypted, credentials_encrypted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${LIST}`,
          [req.actor.organizationId, body.key, body.name, body.kind, body.trackingUrl ?? null, body.adapter ?? null, body.statusMap,
            secret ? box().encrypt(secret) : null, body.credentials ? box().encrypt(JSON.stringify(body.credentials)) : null],
        );
        await audit(tx, req, 'carrier.create', 'carrier', rows[0].id, { key: body.key, kind: body.kind });
        return rows[0];
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw conflict(`There is already a delivery company with the key "${body.key}"`);
        throw e;
      }
    });
    // The signing secret is shown once, here.
    return reply.status(201).send({ ...view(created), ...(secret ? { secret } : {}) });
  });

  app.put('/carriers/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = updateBody.parse(req.body);
    await authorize(db, req.actor, 'carriers.manage', { kind: 'organization' });
    return withTx(db, async (tx) => {
      const c = await loadCarrier(tx, req.actor.organizationId, id);
      if (body.credentials && c.kind !== 'api') throw invalid('Only "api" delivery companies have credentials');
      const { rows } = await tx.query(
        `UPDATE carriers SET name = COALESCE($3, name), tracking_url = CASE WHEN $4::boolean THEN $5 ELSE tracking_url END, status_map = COALESCE($6, status_map),
                active = COALESCE($7, active), credentials_encrypted = COALESCE($8, credentials_encrypted), updated_at = now()
          WHERE id = $1 AND organization_id = $2 RETURNING ${LIST}`,
        [id, req.actor.organizationId, body.name ?? null, body.trackingUrl !== undefined, body.trackingUrl ?? null, body.statusMap ?? null, body.active ?? null,
          body.credentials ? box().encrypt(JSON.stringify(body.credentials)) : null],
      );
      await audit(tx, req, 'carrier.update', 'carrier', id, { changed: Object.keys(body) });
      return view(rows[0]);
    });
  });

  app.post('/carriers/:id/rotate-secret', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await authorize(db, req.actor, 'carriers.manage', { kind: 'organization' });
    const secret = newCarrierSecret();
    return withTx(db, async (tx) => {
      const c = await loadCarrier(tx, req.actor.organizationId, id);
      if (c.kind !== 'webhook') throw invalid('Only webhook delivery companies have a signing secret');
      await tx.query('UPDATE carriers SET webhook_secret_encrypted = $2, updated_at = now() WHERE id = $1', [id, box().encrypt(secret)]);
      await audit(tx, req, 'carrier.rotate_secret', 'carrier', id);
      return { id, secret };
    });
  });

  /** Staff record a progress update by hand (a phone call, a message from the rider's dispatcher). */
  app.post('/sales-orders/:id/shipment/events', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = eventBody.parse(req.body);
    const o = await db.query<{ legal_entity_id: string; shipment_id: string | null; status_map: Record<string, string> | null }>(
      `SELECT o.legal_entity_id, s.id AS shipment_id, c.status_map FROM sales_orders o LEFT JOIN shipments s ON s.order_id = o.id LEFT JOIN carriers c ON c.id = s.carrier_id
        WHERE o.id = $1 AND o.organization_id = $2`, [id, req.actor.organizationId]);
    if (!o.rows[0]) throw notFound('Order');
    await authorize(db, req.actor, 'orders.fulfil', { kind: 'legal_entity', legalEntityId: o.rows[0].legal_entity_id });
    if (!o.rows[0].shipment_id) throw conflict('This order has not been sent yet');
    const r = await applyTrackingEvents(db, o.rows[0].shipment_id, [{ status: body.status, description: body.description, location: body.location, occurredAt: body.occurredAt, eventId: `staff-${crypto.randomUUID()}` }], 'staff', {}, req.actor.userId, req.id);
    return reply.status(201).send(r);
  });
};
