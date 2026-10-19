import type { Tx } from '../db.js';
import { fromScaled, toScaled } from '../domain/decimal.js';

export interface Need {
  variantId: string;
  sku: string;
  tracking: 'none' | 'lot' | 'roll';
  required: string;
}

export interface Allocation {
  variantId: string;
  lotId: string | null;
  quantity: string;
}

export interface Shortage {
  variantId: string;
  sku: string;
  required: string;
  available: string;
  short: string;
}

/**
 * Works out where each requirement can be taken from at a location, without reserving anything. Untracked
 * material comes from the single balance; tracked material is allocated oldest lot first, skipping lots on
 * quality hold. Free stock means on hand minus what other documents have already reserved.
 */
export async function planAllocation(tx: Tx, locationId: string, needs: Need[]): Promise<{ allocations: Allocation[]; shortages: Shortage[] }> {
  const allocations: Allocation[] = [];
  const shortages: Shortage[] = [];
  for (const need of needs) {
    const required = toScaled(need.required);
    let got = 0n;
    if (need.tracking === 'none') {
      const { rows } = await tx.query<{ free: string }>(
        `SELECT quantity - reserved AS free FROM stock_balances
          WHERE location_id = $1 AND variant_id = $2 AND lot_id IS NULL AND state = 'on_hand'`,
        [locationId, need.variantId],
      );
      const free = toScaled(rows[0]?.free ?? '0');
      got = free < required ? free : required;
      if (got > 0n) allocations.push({ variantId: need.variantId, lotId: null, quantity: fromScaled(got) });
    } else {
      const { rows } = await tx.query<{ lot_id: string; free: string }>(
        `SELECT b.lot_id, b.quantity - b.reserved AS free
           FROM stock_balances b JOIN stock_lots l ON l.id = b.lot_id
          WHERE b.location_id = $1 AND b.variant_id = $2 AND b.state = 'on_hand' AND l.hold_status = 'released'
            AND b.quantity - b.reserved > 0
          ORDER BY l.created_at, l.code`,
        [locationId, need.variantId],
      );
      for (const r of rows) {
        if (got >= required) break;
        const free = toScaled(r.free);
        const take = free < required - got ? free : required - got;
        got += take;
        allocations.push({ variantId: need.variantId, lotId: r.lot_id, quantity: fromScaled(take) });
      }
    }
    if (got < required) {
      shortages.push({ variantId: need.variantId, sku: need.sku, required: need.required, available: fromScaled(got), short: fromScaled(required - got) });
    }
  }
  return { allocations, shortages };
}
