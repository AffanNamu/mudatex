import type { Db } from '../db.js';
import type { SecretBox } from '../events/secretbox.js';
import type { AdapterRegistry } from './adapters.js';
import { credentialsOf } from './booking.js';
import { applyTrackingEvents } from './service.js';

/**
 * Asks delivery companies that have a connector where their open parcels are. Each parcel is claimed (marked as asked)
 * before the company is called, so two overlapping runs never ask twice, and one company being down does not hold up the rest.
 */
export async function pollShipments(db: Db, box: SecretBox | null, adapters: AdapterRegistry, opts: { olderThanMinutes?: number; batch?: number } = {}): Promise<{ asked: number; failed: number }> {
  const names = Object.keys(adapters);
  if (!names.length) return { asked: 0, failed: 0 };
  const { rows } = await db.query<{ id: string; tracking_ref: string; external_id: string | null; adapter: string; status_map: Record<string, string>; credentials_encrypted: string | null }>(
    `UPDATE shipments s SET polled_at = now()
      WHERE s.id IN (
        SELECT s2.id FROM shipments s2 JOIN carriers c ON c.id = s2.carrier_id
         WHERE c.kind = 'api' AND c.active AND c.adapter = ANY($1::text[]) AND s2.tracking_ref IS NOT NULL
           AND s2.status NOT IN ('delivered', 'returned', 'cancelled')
           AND (s2.polled_at IS NULL OR s2.polled_at < now() - make_interval(mins => $2))
         ORDER BY s2.polled_at NULLS FIRST LIMIT $3 FOR UPDATE OF s2 SKIP LOCKED)
      RETURNING s.id, s.tracking_ref, s.external_id, (SELECT adapter FROM carriers WHERE id = s.carrier_id) AS adapter,
                (SELECT status_map FROM carriers WHERE id = s.carrier_id) AS status_map, (SELECT credentials_encrypted FROM carriers WHERE id = s.carrier_id) AS credentials_encrypted`,
    [names, opts.olderThanMinutes ?? 60, opts.batch ?? 50],
  );
  let failed = 0;
  for (const s of rows) {
    const adapter = adapters[s.adapter]!;
    if (!adapter.track) continue;
    try {
      const { events, eta } = await adapter.track({ trackingRef: s.tracking_ref, externalId: s.external_id }, credentialsOf(box, { credentialsEncrypted: s.credentials_encrypted }));
      await applyTrackingEvents(db, s.id, events.map((e, i) => ({ ...e, ...(i === 0 && eta ? { eta } : {}) })), 'poll', s.status_map);
    } catch (e) {
      failed++;
      console.error(`tracking poll failed for shipment ${s.id}:`, (e as Error).message);
    }
  }
  return { asked: rows.length, failed };
}
