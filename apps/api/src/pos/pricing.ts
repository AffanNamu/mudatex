import type { Tx } from '../db.js';
import { normalize } from '../domain/decimal.js';
import { MoneyError, priceLine, type DiscountInput } from '../domain/money.js';
import { forbidden, invalid } from '../errors.js';
import { checkLot, loadVariant, resolveQuantity } from '../inventory/common.js';

export interface SaleLineInput {
  variantId: string;
  lotId?: string;
  quantity: string;
  unitId?: string;
  discount?: DiscountInput;
}

export interface PricedSaleLine {
  variantId: string;
  sku: string;
  lotId: string | null;
  quantity: string;          // base unit
  unitPrice: string;
  itemId: string;
  tax: { code: string; rate: string; inclusive: boolean } | null;
  p: ReturnType<typeof priceLine>;
}

export interface PricingContext {
  organizationId: string;
  priceListId: string;
  minorUnit: number;
  maxDiscountBps: number;
  /** May exceed the register's discount limit. */
  mayOverride: boolean;
  now: Date;
}

/**
 * The one place a sale line becomes money: current price, tax, discount, rounding and the register's discount limit.
 * Both real sales and the quote endpoint call this, so what a terminal shows is what a sale will charge.
 */
export async function priceSaleLines(tx: Tx, ctx: PricingContext, lines: SaleLineInput[]): Promise<PricedSaleLine[]> {
  const priced: PricedSaleLine[] = [];
  for (const line of lines) {
    const variant = await loadVariant(tx, ctx.organizationId, line.variantId);
    const lotId = await checkLot(tx, ctx.organizationId, variant, line.lotId);
    const quantity = await resolveQuantity(tx, variant, line.quantity, line.unitId);
    const price = await tx.query<{ id: string; unit_price: string; code: string | null; rate: string | null; price_inclusive: boolean | null }>(
      `SELECT i.id, i.unit_price, t.code, t.rate, t.price_inclusive
         FROM price_list_items i LEFT JOIN tax_codes t ON t.id = i.tax_code_id
        WHERE i.price_list_id = $1 AND i.variant_id = $2 AND i.effective_from <= $3 AND (i.effective_to IS NULL OR i.effective_to > $3)`,
      [ctx.priceListId, variant.id, ctx.now],
    );
    const item = price.rows[0];
    if (!item) throw invalid(`${variant.sku} has no current price on this register's price list`);
    const tax = item.code ? { code: item.code, rate: normalize(item.rate!), inclusive: item.price_inclusive! } : null;
    const unitPrice = normalize(item.unit_price);
    let p;
    try {
      p = priceLine({ quantity, unitPrice, minorUnit: ctx.minorUnit, discount: line.discount, tax });
    } catch (err) {
      if (err instanceof MoneyError) throw invalid(err.message);
      throw err;
    }
    if (p.discount > 0n && p.gross * BigInt(ctx.maxDiscountBps) < p.discount * 10000n && !ctx.mayOverride) {
      throw forbidden(`Discount exceeds this register's limit of ${ctx.maxDiscountBps / 100}%`);
    }
    priced.push({ variantId: variant.id, sku: variant.sku, lotId, quantity, unitPrice, itemId: item.id, tax, p });
  }
  return priced;
}

export function saleTotals(priced: PricedSaleLine[]) {
  const sum = (f: (l: PricedSaleLine) => bigint) => priced.reduce((a, l) => a + f(l), 0n);
  return { subtotal: sum((l) => l.p.gross), discount: sum((l) => l.p.discount), tax: sum((l) => l.p.tax), total: sum((l) => l.p.total) };
}
