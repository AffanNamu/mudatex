import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authorize } from '../auth/authorize.js';
import { withTx, type Db } from '../db.js';
import { AppError, conflict, invalid, notFound } from '../errors.js';
import type { SecretBox } from '../events/secretbox.js';
import { EVENT_PATTERN } from '../events/publish.js';
import { assertSafeUrl, UnsafeUrlError, type UrlPolicy } from '../events/url-safety.js';
import { audit, uuid } from '../inventory/common.js';

const createBody = z.object({
  url: z.string().url().max(2000),
  description: z.string().max(300).optional(),
  eventTypes: z.array(z.string().regex(EVENT_PATTERN)).min(1).max(50),
});

const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;
const COLS = `id, url, description, event_types AS "eventTypes", status, created_at AS "createdAt"`;

export const integrationRoutes: FastifyPluginAsync<{ db: Db; secretBox: SecretBox | null; urlPolicy: UrlPolicy }> = async (app, { db, secretBox, urlPolicy }) => {
  const requireBox = () => {
    if (!secretBox) throw new AppError(503, 'webhooks_not_configured', 'Webhooks need SECRETS_ENCRYPTION_KEY to be set on the server');
    return secretBox;
  };
  const checkUrl = async (u: string) => {
    try { await assertSafeUrl(u, urlPolicy); } catch (e) {
      if (e instanceof UnsafeUrlError) throw invalid(e.message);
      throw e;
    }
  };
  const admin = (req: FastifyRequest, tx: Parameters<typeof authorize>[0] = db) => authorize(tx, req.actor, 'integrations.manage', { kind: 'organization' });

  app.post('/integrations/webhooks', async (req, reply) => {
    const body = createBody.parse(req.body);
    const box = requireBox();
    await checkUrl(body.url);
    const secret = newSecret();
    const created = await withTx(db, async (tx) => {
      await admin(req, tx);
      const { rows } = await tx.query(
        `INSERT INTO webhook_endpoints (organization_id, url, description, event_types, secret_encrypted, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COLS}`,
        [req.actor.organizationId, body.url, body.description ?? null, body.eventTypes, box.encrypt(secret), req.actor.userId],
      );
      await audit(tx, req, 'webhook.create', 'webhook_endpoint', rows[0].id, { url: body.url, eventTypes: body.eventTypes });
      return rows[0];
    });
    // The signing secret is shown once, here, and never again.
    return reply.status(201).send({ ...created, secret });
  });

  app.get('/integrations/webhooks', async (req) => {
    await admin(req);
    const { rows } = await db.query(`SELECT ${COLS} FROM webhook_endpoints WHERE organization_id = $1 ORDER BY created_at DESC, id`, [req.actor.organizationId]);
    return rows;
  });

  const setStatus = (name: string, from: string[], to: string) =>
    app.post(`/integrations/webhooks/:id/${name}`, async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      return withTx(db, async (tx) => {
        await admin(req, tx);
        const cur = await tx.query<{ status: string }>('SELECT status FROM webhook_endpoints WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, req.actor.organizationId]);
        if (!cur.rows[0]) throw notFound('Webhook');
        if (!from.includes(cur.rows[0].status)) throw conflict(`Webhook is ${cur.rows[0].status}`);
        const { rows } = await tx.query(`UPDATE webhook_endpoints SET status = $2 WHERE id = $1 RETURNING ${COLS}`, [id, to]);
        await audit(tx, req, `webhook.${name}`, 'webhook_endpoint', id);
        return rows[0];
      });
    });
  setStatus('pause', ['active'], 'paused');
  setStatus('resume', ['paused'], 'active');
  setStatus('disable', ['active', 'paused'], 'disabled');

  app.post('/integrations/webhooks/:id/rotate-secret', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const box = requireBox();
    const secret = newSecret();
    return withTx(db, async (tx) => {
      await admin(req, tx);
      const r = await tx.query('UPDATE webhook_endpoints SET secret_encrypted = $3 WHERE id = $1 AND organization_id = $2 AND status <> \'disabled\' RETURNING id', [id, req.actor.organizationId, box.encrypt(secret)]);
      if (!r.rowCount) throw notFound('Webhook');
      await audit(tx, req, 'webhook.rotate_secret', 'webhook_endpoint', id);
      return { id, secret };
    });
  });

  // Sends a test event to this one endpoint, bypassing subscriptions, so the receiver can verify its signature handling.
  app.post('/integrations/webhooks/:id/test', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return withTx(db, async (tx) => {
      await admin(req, tx);
      const ep = await tx.query<{ status: string }>('SELECT status FROM webhook_endpoints WHERE id = $1 AND organization_id = $2', [id, req.actor.organizationId]);
      if (!ep.rows[0]) throw notFound('Webhook');
      if (ep.rows[0].status !== 'active') throw conflict(`Webhook is ${ep.rows[0].status}`);
      const ev = await tx.query<{ id: string }>(
        `INSERT INTO domain_events (organization_id, event_type, aggregate_type, aggregate_id, actor_user_id, request_id, fanned_out_at)
         VALUES ($1, 'webhook.test', 'webhook_endpoint', $2, $3, $4, now()) RETURNING id`,
        [req.actor.organizationId, id, req.actor.userId, req.id],
      );
      await tx.query(`INSERT INTO event_deliveries (event_id, organization_id, target_kind, target_key, endpoint_id) VALUES ($1, $2, 'webhook', $3::text, $3::uuid)`, [ev.rows[0]!.id, req.actor.organizationId, id]);
      return { eventId: ev.rows[0]!.id, queued: true };
    });
  });

  app.get('/integrations/deliveries', async (req) => {
    await admin(req);
    const q = z.object({ status: z.enum(['pending', 'sending', 'delivered', 'dead']).optional(), endpointId: uuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const { rows } = await db.query(
      `SELECT d.id, d.event_id::text AS "eventId", e.event_type AS "eventType", d.target_kind AS "targetKind", d.target_key AS "target", d.status, d.attempts,
              d.next_attempt_at AS "nextAttemptAt", d.last_status_code AS "lastStatusCode", d.last_error AS "lastError", d.delivered_at AS "deliveredAt"
         FROM event_deliveries d JOIN domain_events e ON e.id = d.event_id
        WHERE d.organization_id = $1 AND ($2::text IS NULL OR d.status = $2) AND ($3::uuid IS NULL OR d.endpoint_id = $3)
        ORDER BY d.created_at DESC, d.id LIMIT $4`,
      [req.actor.organizationId, q.status ?? null, q.endpointId ?? null, q.limit],
    );
    return rows;
  });

  app.post('/integrations/deliveries/:id/retry', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return withTx(db, async (tx) => {
      await admin(req, tx);
      const r = await tx.query(
        `UPDATE event_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL, last_error = NULL
          WHERE id = $1 AND organization_id = $2 AND status = 'dead' RETURNING id`,
        [id, req.actor.organizationId],
      );
      if (!r.rowCount) throw conflict('Only dead-lettered deliveries can be retried');
      await audit(tx, req, 'webhook.delivery_retry', 'event_delivery', id);
      return { id, status: 'pending' };
    });
  });

  app.get('/integrations/events', async (req) => {
    await admin(req);
    const q = z.object({ type: z.string().optional(), afterId: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const { rows } = await db.query(
      `SELECT id::text AS id, event_type AS type, aggregate_type AS "aggregateType", aggregate_id AS "aggregateId", actor_user_id AS "actorUserId", occurred_at AS "occurredAt"
         FROM domain_events WHERE organization_id = $1 AND id > $2 AND ($3::text IS NULL OR event_type = $3) ORDER BY id LIMIT $4`,
      [req.actor.organizationId, q.afterId, q.type ?? null, q.limit],
    );
    return rows;
  });
};
