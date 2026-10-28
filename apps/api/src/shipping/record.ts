import type { Tx } from '../db.js';
import { conflict } from '../errors.js';

/** Records the parcel when an order is sent. Called inside the transaction that marks the order as shipped. */
export async function recordShipment(
  tx: Tx, organizationId: string, orderId: string,
  s: { carrierId?: string | null; carrierName: string; trackingRef?: string | null; externalId?: string | null; labelUrl?: string | null; eta?: string | null },
): Promise<string> {
  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO shipments (organization_id, order_id, carrier_id, carrier_name, tracking_ref, external_id, label_url, eta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (order_id) DO UPDATE SET carrier_id = EXCLUDED.carrier_id, carrier_name = EXCLUDED.carrier_name, tracking_ref = EXCLUDED.tracking_ref,
              external_id = EXCLUDED.external_id, label_url = EXCLUDED.label_url, eta = EXCLUDED.eta, updated_at = now()
       RETURNING id`,
      [organizationId, orderId, s.carrierId ?? null, s.carrierName, s.trackingRef ?? null, s.externalId ?? null, s.labelUrl ?? null, s.eta ?? null],
    );
    return rows[0]!.id;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw conflict('That tracking number is already used on another order for this delivery company');
    throw e;
  }
}
