import type { Db } from '../db.js';
import type { SecretBox } from '../events/secretbox.js';
import { AppError, invalid, notFound } from '../errors.js';
import type { AdapterRegistry, Parcel } from './adapters.js';

export interface CarrierRow { id: string; key: string; name: string; kind: 'manual' | 'webhook' | 'api'; adapter: string | null; statusMap: Record<string, string>; trackingUrl: string | null; active: boolean; credentialsEncrypted: string | null }

export const CARRIER_COLUMNS = `id, key, name, kind, adapter, status_map AS "statusMap", tracking_url AS "trackingUrl", active, credentials_encrypted AS "credentialsEncrypted"`;

export async function loadCarrier(db: Pick<Db, 'query'>, organizationId: string, id: string): Promise<CarrierRow> {
  const { rows } = await db.query<CarrierRow>(`SELECT ${CARRIER_COLUMNS} FROM carriers WHERE id = $1 AND organization_id = $2`, [id, organizationId]);
  if (!rows[0]) throw notFound('Carrier');
  return rows[0];
}

export function credentialsOf(box: SecretBox | null, c: Pick<CarrierRow, 'credentialsEncrypted'>): Record<string, string> {
  if (!c.credentialsEncrypted) return {};
  if (!box) throw new AppError(503, 'secrets_not_configured', 'Delivery company credentials need SECRETS_ENCRYPTION_KEY to be set on the server');
  return JSON.parse(box.decrypt(c.credentialsEncrypted));
}

/**
 * Before an order is marked as sent with a delivery company that has a connector: asks the company to book the parcel and
 * returns what to record. If the company refuses or cannot be reached, nothing about the order changes.
 */
export async function bookWithCarrier(db: Db, box: SecretBox | null, adapters: AdapterRegistry, organizationId: string, orderId: string, carrier: CarrierRow) {
  if (!carrier.active) throw invalid('That delivery company is switched off');
  if (carrier.kind !== 'api') return null;
  const adapter = adapters[carrier.adapter!];
  if (!adapter?.book) return null;
  const { rows } = await db.query<{ orderNo: string; delivery: Parcel['recipient'] & { recipient: string; phone: string }; lines: { title: string; quantity: string }[] }>(
    `SELECT o.order_no AS "orderNo", o.delivery, (SELECT json_agg(json_build_object('title', l.title, 'quantity', l.quantity::text) ORDER BY l.line_no) FROM sales_order_lines l WHERE l.order_id = o.id) AS lines
       FROM sales_orders o WHERE o.id = $1 AND o.organization_id = $2`, [orderId, organizationId]);
  const o = rows[0];
  if (!o) throw notFound('Order');
  const parcel: Parcel = {
    orderNo: o.orderNo,
    recipient: { name: o.delivery.recipient, phone: o.delivery.phone, line1: o.delivery.line1, line2: o.delivery.line2 ?? null, city: o.delivery.city, state: o.delivery.state, countryCode: o.delivery.countryCode },
    items: o.lines,
  };
  try {
    return await adapter.book(parcel, credentialsOf(box, carrier));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(502, 'carrier_error', `${carrier.name} could not book the parcel: ${(e as Error).message}. Nothing was changed; try again or send it another way.`);
  }
}
