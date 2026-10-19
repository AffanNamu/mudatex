import { withTx, type Db } from '../db.js';
import { fromScaled, toScaled } from '../domain/decimal.js';
import { adjustReserved } from './ledger.js';

/**
 * Releases the unfulfilled remainder of expired active reservations. Intended for a
 * scheduled worker; safe to run concurrently (rows are claimed with SKIP LOCKED).
 */
export async function releaseExpiredReservations(db: Db, now = new Date(), batch = 200): Promise<number> {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      location_id: string;
      variant_id: string;
      lot_id: string | null;
      quantity: string;
      fulfilled_quantity: string;
      released_quantity: string;
    }>(
      `SELECT id, location_id, variant_id, lot_id, quantity, fulfilled_quantity, released_quantity
         FROM stock_reservations WHERE status = 'active' AND expires_at <= $1
         ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, batch],
    );
    for (const r of rows) {
      const left = fromScaled(toScaled(r.quantity) - toScaled(r.fulfilled_quantity) - toScaled(r.released_quantity));
      await adjustReserved(tx, { locationId: r.location_id, variantId: r.variant_id, lotId: r.lot_id }, `-${left}`);
      await tx.query(
        `UPDATE stock_reservations SET released_quantity = released_quantity + $2::numeric, status = 'closed', closed_at = now() WHERE id = $1`,
        [r.id, left],
      );
    }
    return rows.length;
  });
}
