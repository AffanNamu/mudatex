import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import type { SecretBox } from '../events/secretbox.js';
import { applyTrackingEvents } from '../shipping/service.js';

const event = z.object({
  trackingRef: z.string().trim().min(1).max(100),
  status: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  location: z.string().trim().max(200).optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  eventId: z.string().trim().min(1).max(120).optional(),
  eta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const payload = z.union([z.object({ events: z.array(event).min(1).max(100) }), event]);

export function validCarrierSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const given = header.replace(/^sha256=/i, '').trim().toLowerCase();
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * A delivery company (or a tracking service acting for it) reports where parcels are. The call is signed with the secret
 * shown when the delivery company was added: HMAC-SHA256 of the exact body, hex, in the X-Mudatex-Signature header.
 * Body: {"trackingRef": "...", "status": "...", "description": "...", "location": "...", "occurredAt": "...", "eventId": "..."}
 * or {"events": [ ... ]}. The company's own status words are translated by the status map set up for it.
 */
export const carrierWebhookRoutes: FastifyPluginAsync<{ db: Db; secretBox: SecretBox | null }> = async (app, { db, secretBox }) => {
  // The signature covers the exact bytes sent, so this route keeps the body unparsed.
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 512 * 1024 }, (_req, body, done) => done(null, body));

  app.post('/webhooks/carriers/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).safeParse(req.params).data ?? {};
    const notFound = () => reply.status(404).send({ error: 'not_found', message: 'Unknown delivery company' });
    if (!id) return notFound();
    const { rows } = await db.query<{ status_map: Record<string, string>; secret: string | null; active: boolean }>(
      `SELECT status_map, webhook_secret_encrypted AS secret, active FROM carriers WHERE id = $1 AND kind = 'webhook'`, [id]);
    const c = rows[0];
    if (!c || !c.secret || !secretBox) return notFound();
    const raw = req.body as Buffer;
    if (!validCarrierSignature(raw, req.headers['x-mudatex-signature'] as string | undefined, secretBox.decrypt(c.secret))) {
      return reply.status(401).send({ error: 'unauthorized', message: 'Bad signature' });
    }
    if (!c.active) return reply.status(200).send({ ok: true, ignored: 'inactive' });
    let parsed: z.infer<typeof payload>;
    try { parsed = payload.parse(JSON.parse(raw.toString('utf8'))); } catch {
      return reply.status(400).send({ error: 'bad_request', message: 'Invalid body' });
    }
    const events = 'events' in parsed ? parsed.events : [parsed];
    // Group by tracking number: each parcel is updated in one go.
    const byRef = new Map<string, typeof events>();
    for (const e of events) byRef.set(e.trackingRef, [...(byRef.get(e.trackingRef) ?? []), e]);
    let recorded = 0; let duplicate = 0; let unknown = 0;
    for (const [ref, list] of byRef) {
      const s = await db.query<{ id: string }>('SELECT id FROM shipments WHERE carrier_id = $1 AND tracking_ref = $2', [id, ref]);
      if (!s.rows[0]) { unknown += list.length; continue; }
      const r = await applyTrackingEvents(db, s.rows[0].id, list, 'webhook', c.status_map, null, req.id);
      recorded += r.recorded; duplicate += r.duplicate;
    }
    // Always 200 for a correctly signed call, so the sender does not retry for ever over a parcel we do not know.
    return reply.status(200).send({ ok: true, recorded, duplicate, unknown });
  });
};
