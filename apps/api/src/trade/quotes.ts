import { z } from 'zod';
import type { Db, Tx } from '../db.js';
import { normalize } from '../domain/decimal.js';
import { MoneyError, priceLine } from '../domain/money.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';
import { uuid } from '../inventory/common.js';
import { priceSaleLines, type PricedSaleLine } from '../pos/pricing.js';
import type { Storefront } from '../shop/catalog.js';

export const quoteLineBody = z.object({
  variantId: uuid,
  quantity: z.string().regex(/^\d+(\.\d+)?$/, 'Quantity must be a positive decimal string'),
  /** The agreed price for one base unit, tax excluded or included as the price list says. Omit to use the business's trade price. */
  unitPrice: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Price must be a number with up to 4 decimal places').optional(),
});
export type QuoteLineInput = z.infer<typeof quoteLineBody>;

export const MAX_QUOTE_DAYS = 90;
export const MAX_QUOTE_LINES = 100;

const today = () => new Date().toISOString().slice(0, 10);
export const checkValidUntil = (date: string) => {
  const d = Date.parse(`${date}T00:00:00Z`);
  const t = Date.parse(`${today()}T00:00:00Z`);
  if (Number.isNaN(d) || d < t) throw invalid('A quote must be valid until today or later');
  if (d > t + MAX_QUOTE_DAYS * 86_400_000) throw invalid(`A quote can be valid for at most ${MAX_QUOTE_DAYS} days`);
};

export interface QuotedLine extends PricedSaleLine { title: string; listPrice: string }

/**
 * Prices the lines of a quote: the business's trade price unless staff agreed another, with the same tax and rounding as
 * any order. Going below the trade price needs a permission of its own; going above is always allowed.
 */
export async function priceQuoteLines(tx: Tx, sf: Storefront, tradePriceListId: string, lines: QuoteLineInput[], mayUndercut: boolean): Promise<QuotedLine[]> {
  if (!lines.length) throw invalid('A quote needs at least one line');
  if (new Set(lines.map((l) => l.variantId)).size !== lines.length) throw invalid('Each product can appear once on a quote');
  const plain = await priceSaleLines(tx, { organizationId: sf.organizationId, priceListId: tradePriceListId, minorUnit: sf.minorUnit, maxDiscountBps: 0, mayOverride: false, lotsOptional: true, now: new Date() },
    lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })));
  const titles = await tx.query<{ id: string; title: string }>(
    `SELECT v.id, COALESCE(sp.title, p.name) AS title FROM product_variants v JOIN products p ON p.id = v.product_id
       LEFT JOIN storefront_products sp ON sp.product_id = p.id AND sp.storefront_id = $2 WHERE v.id = ANY($1::uuid[])`,
    [lines.map((l) => l.variantId), sf.id],
  );
  const byId = new Map(titles.rows.map((t) => [t.id, t.title]));
  return plain.map((l, i) => {
    const custom = lines[i]!.unitPrice;
    const out: QuotedLine = { ...l, title: byId.get(l.variantId) ?? l.sku, listPrice: l.unitPrice };
    if (custom === undefined) return out;
    const price = normalize(custom);
    if (Number(price) <= 0) throw invalid(`${l.sku}: the price must be above zero`);
    if (Number(price) < Number(l.unitPrice) && !mayUndercut) throw forbidden(`${l.sku}: pricing below the trade price list needs the quotes.price.override permission`);
    try {
      return { ...out, unitPrice: price, p: priceLine({ quantity: l.quantity, unitPrice: price, minorUnit: sf.minorUnit, tax: l.tax }) };
    } catch (err) {
      if (err instanceof MoneyError) throw invalid(err.message);
      throw err;
    }
  });
}

export async function saveQuoteLines(tx: Tx, quoteId: string, priced: QuotedLine[]): Promise<{ subtotal: bigint; tax: bigint }> {
  await tx.query('DELETE FROM quote_lines WHERE quote_id = $1', [quoteId]);
  let subtotal = 0n;
  let tax = 0n;
  for (const [i, l] of priced.entries()) {
    await tx.query(
      `INSERT INTO quote_lines (quote_id, line_no, variant_id, sku, title, quantity, unit_price, list_price, tax_code, tax_rate, tax_inclusive, gross_minor, tax_minor, total_minor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [quoteId, i + 1, l.variantId, l.sku, l.title, l.quantity, l.unitPrice, l.listPrice, l.tax?.code ?? null, l.tax?.rate ?? null, l.tax?.inclusive ?? null, l.p.gross, l.p.tax, l.p.total],
    );
    subtotal += l.p.total;
    tax += l.p.tax;
  }
  await tx.query('UPDATE quotes SET subtotal_minor = $2, tax_minor = $3 WHERE id = $1', [quoteId, subtotal, tax]);
  return { subtotal, tax };
}

/** `sent` quotes past their date read as `expired` without anything having to run. */
const STATUS = `CASE WHEN q.status = 'sent' AND q.valid_until < CURRENT_DATE THEN 'expired' ELSE q.status END`;

export async function readQuote(db: Pick<Db, 'query'>, where: { id?: string; quoteNo?: string; customerId?: string; organizationId: string; storefrontId?: string }) {
  const { rows } = await db.query(
    `SELECT q.id, q.quote_no AS "quoteNo", ${STATUS} AS status, q.currency, cu.minor_unit AS "minorUnit", to_char(q.valid_until, 'YYYY-MM-DD') AS "validUntil", q.note,
            q.subtotal_minor::float8 AS "subtotalMinor", q.tax_minor::float8 AS "taxMinor", q.created_at AS "createdAt", q.sent_at AS "sentAt", q.decided_at AS "decidedAt",
            q.legal_entity_id AS "legalEntityId", q.storefront_id AS "storefrontId", q.trade_account_id AS "tradeAccountId", q.customer_id AS "customerId", q.created_by AS "createdBy",
            (SELECT order_no FROM sales_orders WHERE id = q.order_id) AS "orderNo", t.business_name AS "businessName", c.full_name AS "contactName", c.email
       FROM quotes q JOIN currencies cu ON cu.code = q.currency JOIN trade_accounts t ON t.id = q.trade_account_id JOIN customers c ON c.id = q.customer_id
      WHERE q.organization_id = $1 AND ($2::uuid IS NULL OR q.id = $2) AND ($3::text IS NULL OR q.quote_no = $3) AND ($4::uuid IS NULL OR q.customer_id = $4)
        AND ($5::uuid IS NULL OR q.storefront_id = $5)`,
    [where.organizationId, where.id ?? null, where.quoteNo ?? null, where.customerId ?? null, where.storefrontId ?? null],
  );
  if (!rows[0]) throw notFound('Quote');
  const lines = await db.query(
    `SELECT line_no AS "lineNo", variant_id AS "variantId", sku, title, quantity, unit_price AS "unitPrice", list_price AS "listPrice", tax_code AS "taxCode",
            gross_minor::float8 AS "grossMinor", tax_minor::float8 AS "taxMinor", total_minor::float8 AS "totalMinor"
       FROM quote_lines WHERE quote_id = $1 ORDER BY line_no`,
    [rows[0].id],
  );
  return { ...rows[0], lines: lines.rows.map((l) => ({ ...l, quantity: normalize(l.quantity), unitPrice: normalize(l.unitPrice), listPrice: normalize(l.listPrice) })) };
}

/**
 * Locks a quote for the order that accepts it and rebuilds its priced lines exactly as agreed. Refuses one that is not open,
 * is past its date, or belongs to someone else.
 */
export async function quoteForOrder(tx: Tx, sf: Storefront, customerId: string, quoteNo: string) {
  const { rows } = await tx.query<{ id: string; status: string; expired: boolean }>(
    `SELECT id, status, valid_until < CURRENT_DATE AS expired FROM quotes WHERE storefront_id = $1 AND customer_id = $2 AND quote_no = $3 FOR UPDATE`,
    [sf.id, customerId, quoteNo],
  );
  const q = rows[0];
  if (!q || q.status === 'draft') throw notFound('Quote');
  if (q.status !== 'sent') throw conflict(`This quote is ${q.status} and cannot be accepted`, { key: 'err.quote.closed' });
  if (q.expired) throw conflict('This quote has expired', { key: 'err.quote.expired' });
  const lines = await tx.query<{ variant_id: string; sku: string; title: string; quantity: string; unit_price: string; list_price: string; tax_code: string | null; tax_rate: string | null; tax_inclusive: boolean | null; total_minor: string }>(
    'SELECT variant_id, sku, title, quantity, unit_price, list_price, tax_code, tax_rate, tax_inclusive, total_minor FROM quote_lines WHERE quote_id = $1 ORDER BY line_no',
    [q.id],
  );
  const priced: QuotedLine[] = lines.rows.map((l) => {
    const tax = l.tax_code ? { code: l.tax_code, rate: normalize(l.tax_rate!), inclusive: l.tax_inclusive! } : null;
    const quantity = normalize(l.quantity);
    const unitPrice = normalize(l.unit_price);
    const p = priceLine({ quantity, unitPrice, minorUnit: sf.minorUnit, tax });
    if (p.total !== BigInt(l.total_minor)) throw conflict('This quote can no longer be priced as agreed; ask the shop for a new one');
    return { variantId: l.variant_id, sku: l.sku, lotId: null, quantity, unitPrice, itemId: '', tax, p, title: l.title, listPrice: normalize(l.list_price) };
  });
  return { id: q.id, priced };
}
