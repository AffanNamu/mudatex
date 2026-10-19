import type { Tx } from '../db.js';
import { conflict } from '../errors.js';

export type StockState = 'on_hand' | 'in_transit';
export type MovementType =
  | 'receipt'
  | 'issue'
  | 'adjustment'
  | 'transfer_dispatch'
  | 'transfer_receive'
  | 'transfer_cancel'
  | 'roll_split'
  | 'sale_return'
  | 'supplier_return';

export interface StockKey {
  locationId: string;
  variantId: string;
  lotId: string | null;
  state: StockState;
}

export interface Posting extends StockKey {
  /** Signed base-unit decimal string. Positive adds stock, negative removes it. */
  delta: string;
  type: MovementType;
  /** Reservation quantity released in the same statement (fulfilment). */
  reservedDelta?: string;
}

export interface PostContext {
  organizationId: string;
  actorUserId: string;
  requestId?: string;
  commandId?: string;
  reason?: string;
  referenceType?: string;
  referenceId?: string;
}

const NIL = '00000000-0000-0000-0000-000000000000';
const keyOf = (k: StockKey) => `${k.locationId}|${k.variantId}|${k.lotId ?? NIL}|${k.state}`;

/** Maps a balance CHECK violation to a business error; anything else is rethrown. */
function translate(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23514' && e.constraint?.startsWith('stock_balances_')) {
    throw conflict('Insufficient available stock');
  }
  throw err;
}

/**
 * Applies postings to the balance projection and appends the matching ledger rows,
 * all in the caller's transaction. Rows are locked in a fixed order so concurrent
 * commands cannot deadlock, and the balance CHECK constraints make overselling
 * impossible even if a caller forgets to pre-check.
 */
export async function postMovements(tx: Tx, ctx: PostContext, postings: Posting[]): Promise<{ commandId: string }> {
  const commandId = ctx.commandId ?? crypto.randomUUID();
  const ordered = [...postings].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));

  for (const p of ordered) {
    await tx.query(
      `INSERT INTO stock_balances (organization_id, location_id, variant_id, lot_id, state)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [ctx.organizationId, p.locationId, p.variantId, p.lotId, p.state],
    );
  }
  for (const p of ordered) {
    try {
      await tx.query(
        `UPDATE stock_balances
            SET quantity = quantity + $5::numeric, reserved = reserved + $6::numeric, updated_at = now()
          WHERE location_id = $1 AND variant_id = $2 AND lot_key = COALESCE($3::uuid, '${NIL}'::uuid) AND state = $4`,
        [p.locationId, p.variantId, p.lotId, p.state, p.delta, p.reservedDelta ?? '0'],
      );
    } catch (err) {
      translate(err);
    }
    await tx.query('INSERT INTO stock_tracking_lock (variant_id) VALUES ($1) ON CONFLICT DO NOTHING', [p.variantId]);
    await tx.query(
      `INSERT INTO stock_movements
         (organization_id, command_id, movement_type, location_id, variant_id, lot_id, state, quantity,
          reason, reference_type, reference_id, actor_user_id, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        ctx.organizationId,
        commandId,
        p.type,
        p.locationId,
        p.variantId,
        p.lotId,
        p.state,
        p.delta,
        ctx.reason ?? null,
        ctx.referenceType ?? null,
        ctx.referenceId ?? null,
        ctx.actorUserId,
        ctx.requestId ?? null,
      ],
    );
  }
  return { commandId };
}

/** Moves the reserved counter on an on-hand balance without changing quantity. */
export async function adjustReserved(tx: Tx, k: Omit<StockKey, 'state'>, delta: string): Promise<void> {
  try {
    const { rowCount } = await tx.query(
      `UPDATE stock_balances SET reserved = reserved + $4::numeric, updated_at = now()
        WHERE location_id = $1 AND variant_id = $2 AND lot_key = COALESCE($3::uuid, '${NIL}'::uuid) AND state = 'on_hand'`,
      [k.locationId, k.variantId, k.lotId, delta],
    );
    if (!rowCount) throw conflict('Insufficient available stock');
  } catch (err) {
    translate(err);
  }
}
