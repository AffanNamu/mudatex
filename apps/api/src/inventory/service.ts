import type { Tx } from '../db.js';
import { conflict, invalid } from '../errors.js';
import { postMovements, type MovementType } from './ledger.js';
import type { VariantInfo } from './common.js';
import { fromScaled, toScaled } from '../domain/decimal.js';
import { adjustReserved } from './ledger.js';

/** Reservation helpers for other modules (POS). The reference ties reservations to a business document. */

export interface ReserveInput {
  organizationId: string;
  userId: string;
  locationId: string;
  variantId: string;
  lotId: string | null;
  quantity: string; // base unit, positive
  referenceType: string;
  referenceId: string;
}

export async function createReservation(tx: Tx, r: ReserveInput): Promise<string> {
  await adjustReserved(tx, { locationId: r.locationId, variantId: r.variantId, lotId: r.lotId }, r.quantity);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO stock_reservations
       (organization_id, location_id, variant_id, lot_id, quantity, reference_type, reference_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [r.organizationId, r.locationId, r.variantId, r.lotId, r.quantity, r.referenceType, r.referenceId, r.userId],
  );
  return rows[0]!.id;
}

interface Open {
  id: string;
  location_id: string;
  variant_id: string;
  lot_id: string | null;
  quantity: string;
  fulfilled_quantity: string;
  released_quantity: string;
}

async function lockOpen(tx: Tx, referenceType: string, referenceId: string): Promise<Open[]> {
  const { rows } = await tx.query<Open>(
    `SELECT id, location_id, variant_id, lot_id, quantity, fulfilled_quantity, released_quantity
       FROM stock_reservations WHERE status = 'active' AND reference_type = $1 AND reference_id = $2
      ORDER BY id FOR UPDATE`,
    [referenceType, referenceId],
  );
  return rows;
}

const left = (r: Open) => toScaled(r.quantity) - toScaled(r.fulfilled_quantity) - toScaled(r.released_quantity);

/** Turns every open reservation for the document into issued stock. */
export async function fulfilReferenceReservations(
  tx: Tx,
  ctx: { organizationId: string; actorUserId: string; requestId?: string },
  referenceType: string,
  referenceId: string,
  reason: string,
): Promise<void> {
  const rows = await lockOpen(tx, referenceType, referenceId);
  await assertLotsReleased(tx, rows.map((r) => r.lot_id));
  for (const r of rows) {
    const qty = fromScaled(left(r));
    await postMovements(tx, { ...ctx, reason, referenceType, referenceId }, [
      { locationId: r.location_id, variantId: r.variant_id, lotId: r.lot_id, state: 'on_hand', delta: `-${qty}`, reservedDelta: `-${qty}`, type: 'issue' },
    ]);
    await tx.query(
      `UPDATE stock_reservations SET fulfilled_quantity = fulfilled_quantity + $2::numeric, status = 'closed', closed_at = now() WHERE id = $1`,
      [r.id, qty],
    );
  }
}

/** Frees the stock held for the document. */
export async function releaseReferenceReservations(tx: Tx, referenceType: string, referenceId: string): Promise<void> {
  const rows = await lockOpen(tx, referenceType, referenceId);
  for (const r of rows) {
    const qty = fromScaled(left(r));
    await adjustReserved(tx, { locationId: r.location_id, variantId: r.variant_id, lotId: r.lot_id }, `-${qty}`);
    await tx.query(
      `UPDATE stock_reservations SET released_quantity = released_quantity + $2::numeric, status = 'closed', closed_at = now() WHERE id = $1`,
      [r.id, qty],
    );
  }
}

/**
 * Finds or creates the lot/roll a received quantity belongs to. Untracked variants get no lot; roll codes
 * must be new; lot codes accumulate into the existing lot.
 */
export async function resolveReceiptLot(
  tx: Tx,
  organizationId: string,
  variant: VariantInfo,
  lotCode: string | undefined,
  quantity: string,
): Promise<string | null> {
  if (variant.tracking === 'none') {
    if (lotCode) throw invalid(`${variant.sku} is not lot or roll tracked`);
    return null;
  }
  if (!lotCode) throw invalid(`${variant.sku} is ${variant.tracking}-tracked; lotCode is required`);
  const existing = await tx.query<{ id: string }>(
    'SELECT id FROM stock_lots WHERE organization_id = $1 AND variant_id = $2 AND code = $3',
    [organizationId, variant.id, lotCode],
  );
  if (existing.rows[0]) {
    if (variant.tracking === 'roll') throw conflict(`Roll ${lotCode} already exists`);
    return existing.rows[0].id;
  }
  const created = await tx.query<{ id: string }>(
    `INSERT INTO stock_lots (organization_id, variant_id, kind, code, initial_quantity)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [organizationId, variant.id, variant.tracking, lotCode, quantity],
  );
  return created.rows[0]!.id;
}

/** Stops reserved stock from being issued or sold after its lot was put on quality hold. */
export async function assertLotsReleased(tx: Tx, lotIds: (string | null)[]): Promise<void> {
  const ids = [...new Set(lotIds.filter((x): x is string => !!x))];
  if (!ids.length) return;
  const { rows } = await tx.query<{ code: string }>(`SELECT code FROM stock_lots WHERE id = ANY($1::uuid[]) AND hold_status = 'quarantined'`, [ids]);
  if (rows[0]) throw conflict(`Lot ${rows[0].code} is quarantined and cannot be used until a quality release`);
}

/**
 * Issues part of a reservation: moves stock out and reduces both the balance and the reserved counter
 * in one statement, then records the progress on the reservation.
 */
export async function consumeReservation(
  tx: Tx,
  ctx: { organizationId: string; actorUserId: string; requestId?: string; reason: string; referenceType: string; referenceId: string },
  reservationId: string,
  quantity: string,
  type: MovementType,
): Promise<void> {
  const { rows } = await tx.query<Open>(
    `SELECT id, location_id, variant_id, lot_id, quantity, fulfilled_quantity, released_quantity
       FROM stock_reservations WHERE id = $1 AND status = 'active' FOR UPDATE`,
    [reservationId],
  );
  const r = rows[0];
  if (!r) throw conflict('Reservation is no longer active');
  if (toScaled(quantity) > left(r)) throw conflict('Quantity exceeds the reserved remainder');
  await assertLotsReleased(tx, [r.lot_id]);
  await postMovements(tx, ctx, [
    { locationId: r.location_id, variantId: r.variant_id, lotId: r.lot_id, state: 'on_hand', delta: `-${quantity}`, reservedDelta: `-${quantity}`, type },
  ]);
  const done = toScaled(quantity) === left(r);
  await tx.query(
    `UPDATE stock_reservations SET fulfilled_quantity = fulfilled_quantity + $2::numeric,
            status = CASE WHEN $3 THEN 'closed' ELSE status END, closed_at = CASE WHEN $3 THEN now() ELSE closed_at END WHERE id = $1`,
    [reservationId, quantity, done],
  );
}
