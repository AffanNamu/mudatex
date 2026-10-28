import { createHash, randomBytes } from 'node:crypto';
import { writeAudit } from '../audit.js';
import { withTx, type Db, type Tx } from '../db.js';
import { advanceOrder, type Actor } from '../shop/orders.js';
import type { TrackedEvent } from './adapters.js';
export { recordShipment } from './record.js';
export { trackingUrl } from './url.js';

export const SHIPMENT_STATUSES = ['booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned', 'cancelled'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
const isStatus = (s: string): s is ShipmentStatus => (SHIPMENT_STATUSES as readonly string[]).includes(s);
export const FINAL: readonly ShipmentStatus[] = ['delivered', 'returned', 'cancelled'];

/** The company's word for a stage, as ours. Our own words pass through; anything else needs an entry in the carrier's status map. */
export function mapStatus(raw: string, statusMap: Record<string, string>): ShipmentStatus | null {
  const word = raw.trim().toLowerCase();
  const mapped = statusMap[word];
  if (mapped && isStatus(mapped)) return mapped;
  const own = word.replace(/[\s-]+/g, '_');
  return isStatus(own) ? own : null;
}

export interface IncomingEvent extends TrackedEvent { eta?: string }

export interface ApplyResult { recorded: number; duplicate: number; orderDelivered: boolean }

const eventId = (ref: string, e: TrackedEvent, at: Date) => e.eventId?.slice(0, 120) ?? createHash('sha256').update(`${ref}|${e.status}|${at.toISOString()}|${e.description ?? ''}`).digest('hex').slice(0, 40);

/**
 * Takes tracking updates for one parcel: records each once, works out where the parcel now is from the most recent update
 * (so a late or repeated message cannot move it backwards), and acts on the order: a delivery closes it, a failed
 * delivery or a return leaves a note for staff.
 */
export async function applyTrackingEvents(
  db: Db, shipmentId: string, events: IncomingEvent[], source: 'staff' | 'webhook' | 'poll', statusMap: Record<string, string>, actorUserId: string | null = null, requestId?: string,
): Promise<ApplyResult> {
  let delivered: { organizationId: string; orderId: string; carrierName: string } | null = null;
  const result = await withTx(db, async (tx) => {
    const { rows } = await tx.query<{ organization_id: string; order_id: string; carrier_name: string; tracking_ref: string | null; status: ShipmentStatus; order_status: string }>(
      `SELECT s.organization_id, s.order_id, s.carrier_name, s.tracking_ref, s.status, o.status AS order_status
         FROM shipments s JOIN sales_orders o ON o.id = s.order_id WHERE s.id = $1 FOR UPDATE OF s`,
      [shipmentId],
    );
    const sh = rows[0];
    if (!sh) return { recorded: 0, duplicate: 0, orderDelivered: false };
    let recorded = 0; let duplicate = 0; let eta: string | undefined;
    for (const e of events) {
      const at = e.occurredAt ? new Date(e.occurredAt) : new Date();
      const when = Number.isNaN(at.getTime()) ? new Date() : at;
      const mapped = mapStatus(e.status, statusMap);
      const desc = [e.description, mapped ? null : `(${e.status})`].filter(Boolean).join(' ').slice(0, 300) || null;
      const ins = await tx.query(
        `INSERT INTO shipment_events (shipment_id, status, description, location, occurred_at, source, external_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (shipment_id, external_event_id) DO NOTHING`,
        [shipmentId, mapped, desc, e.location?.slice(0, 200) ?? null, when, source, eventId(sh.tracking_ref ?? shipmentId, e, when)],
      );
      if (ins.rowCount) recorded++; else duplicate++;
      if (e.eta && /^\d{4}-\d{2}-\d{2}$/.test(e.eta)) eta = e.eta;
    }
    if (recorded === 0 && !eta) return { recorded, duplicate, orderDelivered: false };
    // Where the parcel is now: the stage of the latest update that names a stage.
    const latest = await tx.query<{ status: ShipmentStatus; occurred_at: Date; description: string | null }>(
      `SELECT status, occurred_at, description FROM shipment_events WHERE shipment_id = $1 AND status IS NOT NULL ORDER BY occurred_at DESC, id DESC LIMIT 1`, [shipmentId],
    );
    const now = latest.rows[0];
    await tx.query(
      `UPDATE shipments SET status = COALESCE($2, status), last_event_at = COALESCE($3, last_event_at), eta = COALESCE($4::date, eta), updated_at = now() WHERE id = $1`,
      [shipmentId, now?.status ?? null, now?.occurred_at ?? null, eta ?? null],
    );
    if (now && now.status !== sh.status) {
      if (now.status === 'delivered' && sh.order_status === 'shipped') delivered = { organizationId: sh.organization_id, orderId: sh.order_id, carrierName: sh.carrier_name };
      if (now.status === 'failed' || now.status === 'returned') {
        await tx.query(`INSERT INTO sales_order_events (order_id, status, actor_type, actor_id, note) VALUES ($1, $2, $3, $4, $5)`,
          [sh.order_id, sh.order_status, actorUserId ? 'staff' : 'system', actorUserId, `Delivery ${now.status === 'failed' ? 'failed' : 'returned to sender'} (${sh.carrier_name})${now.description ? `: ${now.description}` : ''}`]);
      }
      await writeAudit(tx, { organizationId: sh.organization_id, actorUserId, requestId, action: 'shipment.status', entityType: 'shipment', entityId: shipmentId, before: { status: sh.status }, after: { status: now.status, source } });
    }
    return { recorded, duplicate, orderDelivered: false };
  });
  if (delivered) {
    const d = delivered as { organizationId: string; orderId: string; carrierName: string };
    // The company says it arrived: close the order the same way staff would. If staff got there first, nothing is left to do.
    const actor: Actor = actorUserId ? { type: 'staff', id: actorUserId } : { type: 'system', id: null };
    await advanceOrder(db, d.organizationId, d.orderId, 'deliver', { note: `Delivered, as reported by ${d.carrierName}` }, actor, requestId).catch((e: { status?: number }) => { if (e.status !== 409) throw e; });
    result.orderDelivered = true;
  }
  return result;
}

/** A secret for signing a carrier's webhook calls, shown once. */
export const newCarrierSecret = () => `cws_${randomBytes(32).toString('base64url')}`;
