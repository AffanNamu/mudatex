import { createHash } from 'node:crypto';
import { writeAudit } from '../audit.js';
import { nextDocumentNumber } from '../documents.js';
import { withTx, type Db, type Tx } from '../db.js';
import { fromScaled, normalize, toScaled } from '../domain/decimal.js';
import { conflict, invalid, notFound, shortage } from '../errors.js';
import { stable } from '../idempotency.js';
import { fulfilReferenceReservations, createReservation, releaseReferenceReservations } from '../inventory/service.js';
import { priceSaleLines, saleTotals, type PricedSaleLine } from '../pos/pricing.js';
import { availability, quoteDelivery, type Storefront } from './catalog.js';
import { quoteForOrder } from '../trade/quotes.js';
import { recordShipment } from '../shipping/record.js';
import { trackingUrl } from '../shipping/url.js';

const statusWord = (status: string) => `@err.status.${status}`;

export const ORDER_HOLD_MINUTES = { card: 60, bank_transfer: 24 * 60 } as const;
export const MAX_ORDER_LINES = 50;

export interface PlaceOrderInput {
  lines: { variantId: string; quantity: string; unitId?: string }[];
  couponCode?: string;
  addressId: string;
  paymentMethod: 'card' | 'bank_transfer' | 'account';
  note?: string;
  /** Accepting a quote: the order is placed at exactly the quoted lines and prices, whatever else is sent. */
  quoteNo?: string;
}

export type Actor = { type: 'customer'; id: string } | { type: 'staff'; id: string } | { type: 'system'; id: null };

const ORDER_COLUMNS = `o.id, o.order_no AS "orderNo", o.status, o.currency, o.subtotal_minor AS "subtotalMinor", o.tax_minor AS "taxMinor",
  o.delivery_fee_minor AS "deliveryFeeMinor", o.total_minor AS "totalMinor", o.paid_minor AS "paidMinor", o.refund_due_minor AS "refundDueMinor",
  o.payment_method AS "paymentMethod", o.contact, o.delivery, o.note, o.carrier, o.tracking_ref AS "trackingRef", o.cancel_reason AS "cancelReason",
  o.discount_minor AS "discountMinor", (SELECT code FROM coupons WHERE id = o.coupon_id) AS "couponCode", to_char(o.due_on, 'YYYY-MM-DD') AS "dueOn", o.expires_at AS "expiresAt", o.placed_at AS "placedAt", o.paid_at AS "paidAt", o.shipped_at AS "shippedAt", o.delivered_at AS "deliveredAt"`;

const MONEY_FIELDS = ['discountMinor', 'subtotalMinor', 'taxMinor', 'deliveryFeeMinor', 'totalMinor', 'paidMinor', 'refundDueMinor'] as const;
const asNumbers = <T extends Record<string, any>>(row: T): T => {
  const out: Record<string, any> = { ...row };
  for (const f of MONEY_FIELDS) if (f in out) out[f] = Number(out[f]);
  return out as T;
};

export async function readOrder(q: Pick<Db, 'query'>, where: { id?: string; orderNo?: string; customerId?: string; organizationId: string }, withPayments = false) {
  const { rows } = await q.query(
    `SELECT ${ORDER_COLUMNS}, o.customer_id AS "customerId", o.legal_entity_id AS "legalEntityId", o.storefront_id AS "storefrontId", cu.minor_unit AS "minorUnit"
       FROM sales_orders o JOIN currencies cu ON cu.code = o.currency
      WHERE o.organization_id = $1 AND ($2::uuid IS NULL OR o.id = $2) AND ($3::text IS NULL OR o.order_no = $3) AND ($4::uuid IS NULL OR o.customer_id = $4)`,
    [where.organizationId, where.id ?? null, where.orderNo ?? null, where.customerId ?? null],
  );
  if (!rows[0]) throw notFound('Order');
  const order = asNumbers(rows[0]);
  const lines = await q.query(
    `SELECT line_no AS "lineNo", variant_id AS "variantId", sku, title,
            (SELECT sp.slug FROM storefront_products sp JOIN product_variants pv ON pv.product_id = sp.product_id WHERE pv.id = sales_order_lines.variant_id AND sp.storefront_id = $2) AS "productSlug",
            (SELECT u.code FROM product_variants pv JOIN products p ON p.id = pv.product_id JOIN units u ON u.id = p.base_unit_id WHERE pv.id = sales_order_lines.variant_id) AS "unit",
            (SELECT sp.images->>0 FROM storefront_products sp JOIN product_variants pv ON pv.product_id = sp.product_id WHERE pv.id = sales_order_lines.variant_id AND sp.storefront_id = $2) AS "image", quantity, unit_price AS "unitPrice", tax_code AS "taxCode",
            gross_minor AS "grossMinor", discount_minor AS "discountMinor", tax_minor AS "taxMinor", total_minor AS "totalMinor"
       FROM sales_order_lines WHERE order_id = $1 ORDER BY line_no`,
    [order.id, order.storefrontId],
  );
  const events = await q.query(`SELECT status, actor_type AS "actorType", note, at FROM sales_order_events WHERE order_id = $1 ORDER BY id`, [order.id]);
  const sh = await q.query(
    `SELECT s.id, s.status, s.carrier_name AS "carrierName", s.tracking_ref AS "trackingRef", to_char(s.eta, 'YYYY-MM-DD') AS eta, c.tracking_url AS "template"
       FROM shipments s LEFT JOIN carriers c ON c.id = s.carrier_id WHERE s.order_id = $1`, [order.id]);
  let shipment: Record<string, unknown> | null = null;
  if (sh.rows[0]) {
    const { id: shipmentId, template, ...s } = sh.rows[0];
    const ev = await q.query(`SELECT status, description, location, occurred_at AS at FROM shipment_events WHERE shipment_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 50`, [shipmentId]);
    shipment = { ...s, trackingUrl: trackingUrl(template, s.trackingRef), events: ev.rows };
  }
  const result: Record<string, unknown> = {
    ...order,
    shipment,
    lines: lines.rows.map((l) => ({ ...l, quantity: normalize(l.quantity), unitPrice: normalize(l.unitPrice), grossMinor: Number(l.grossMinor), discountMinor: Number(l.discountMinor), taxMinor: Number(l.taxMinor), totalMinor: Number(l.totalMinor) })),
    events: events.rows,
  };
  if (withPayments) {
    const pay = await q.query(`SELECT method, provider, reference, amount_minor AS "amountMinor", created_at AS "at" FROM sales_order_payments WHERE order_id = $1 ORDER BY created_at`, [order.id]);
    result.payments = pay.rows.map((p) => ({ ...p, amountMinor: Number(p.amountMinor) }));
  }
  return result as any;
}

async function addEvent(tx: Tx, orderId: string, status: string, actor: Actor, note?: string) {
  await tx.query('INSERT INTO sales_order_events (order_id, status, actor_type, actor_id, note) VALUES ($1, $2, $3, $4, $5)', [orderId, status, actor.type, actor.id, note ?? null]);
}

const audit = (tx: Tx, organizationId: string, actor: Actor, action: string, orderId: string, after: unknown, requestId?: string) =>
  writeAudit(tx, { organizationId, actorUserId: actor.type === 'staff' ? actor.id : null, requestId, action, entityType: 'sales_order', entityId: orderId, after: { actor, ...(after as object) } });

interface Alloc { locationId: string; lotId: string | null; quantity: string }

/** Takes stock for one variant from the storefront's locations, oldest lots first, never from quarantined lots. */
async function allocate(tx: Tx, sf: Storefront, variantId: string, quantity: string): Promise<{ allocs: Alloc[]; missing: string }> {
  const { rows } = await tx.query<{ location_id: string; lot_id: string | null; avail: string }>(
    `SELECT b.location_id, b.lot_id, b.quantity - b.reserved AS avail
       FROM stock_balances b LEFT JOIN stock_lots l ON l.id = b.lot_id
      WHERE b.organization_id = $1 AND b.variant_id = $2 AND b.state = 'on_hand' AND b.location_id = ANY($3::uuid[])
        AND b.quantity - b.reserved > 0 AND (l.id IS NULL OR l.hold_status = 'released')
      ORDER BY array_position($3::uuid[], b.location_id), l.created_at NULLS FIRST, b.lot_key
        FOR UPDATE OF b`,
    [sf.organizationId, variantId, sf.stockLocationIds],
  );
  let need = toScaled(quantity);
  const allocs: Alloc[] = [];
  for (const r of rows) {
    if (need <= 0n) break;
    const take = toScaled(r.avail) < need ? toScaled(r.avail) : need;
    allocs.push({ locationId: r.location_id, lotId: r.lot_id, quantity: fromScaled(take) });
    need -= take;
  }
  return { allocs, missing: fromScaled(need > 0n ? need : 0n) };
}

export interface CouponInfo { id: string; code: string; percentBps: number; minSubtotalMinor: bigint }

/**
 * Finds the coupon a shopper typed and checks every rule: store, switch, dates, minimum basket, total uses and uses
 * by this customer (orders that were cancelled or lapsed do not count). `lock` serialises concurrent checkouts.
 */
export async function resolveCoupon(tx: Tx, sf: Storefront, rawCode: string, basketMinor: bigint, customerId: string | null, lock: boolean): Promise<CouponInfo> {
  const code = rawCode.trim().toUpperCase();
  const { rows } = await tx.query<{ id: string; percent_bps: number; min_subtotal_minor: string; max_redemptions: number | null; per_customer_limit: number; starts_at: Date | null; ends_at: Date | null; active: boolean }>(
    `SELECT id, percent_bps, min_subtotal_minor, max_redemptions, per_customer_limit, starts_at, ends_at, active
       FROM coupons WHERE storefront_id = $1 AND code = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [sf.id, code],
  );
  const c = rows[0];
  const now = new Date();
  if (!c || !c.active) throw invalid('That coupon code is not valid', { key: 'err.coupon.invalid' });
  if (c.starts_at && c.starts_at > now) throw invalid('That coupon is not active yet', { key: 'err.coupon.notActive' });
  if (c.ends_at && c.ends_at <= now) throw invalid('That coupon has expired', { key: 'err.coupon.expired' });
  if (basketMinor < BigInt(c.min_subtotal_minor)) throw invalid('Your basket is below the minimum for this coupon', { key: 'err.coupon.minimum' });
  const used = await tx.query<{ total: number; mine: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE customer_id = $2)::int AS mine
       FROM sales_orders WHERE coupon_id = $1 AND status NOT IN ('cancelled', 'expired')`,
    [c.id, customerId],
  );
  if (c.max_redemptions !== null && used.rows[0]!.total >= c.max_redemptions) throw invalid('That coupon has been fully used', { key: 'err.coupon.used' });
  if (customerId && used.rows[0]!.mine >= c.per_customer_limit) throw invalid('You have already used that coupon', { key: 'err.coupon.mine' });
  return { id: c.id, code, percentBps: c.percent_bps, minSubtotalMinor: BigInt(c.min_subtotal_minor) };
}

/** Prices the lines, applying the coupon (checked against the undiscounted basket) when one is named. */
async function priceWithCoupon(tx: Tx, sf: Storefront, lines: PlaceOrderInput['lines'], couponCode: string | undefined, customerId: string | null, lock: boolean) {
  const base = { organizationId: sf.organizationId, priceListId: sf.priceListId, minorUnit: sf.minorUnit, maxDiscountBps: 0, mayOverride: false, lotsOptional: true, now: new Date() };
  const plain = await priceSaleLines(tx, base, lines);
  if (!couponCode?.trim()) return { priced: plain, coupon: null as CouponInfo | null };
  const coupon = await resolveCoupon(tx, sf, couponCode, saleTotals(plain).total, customerId, lock);
  // Coupons are the shop's own offer, so they are exempt from a till's cashier discount limit.
  const priced = await priceSaleLines(tx, { ...base, mayOverride: true }, lines.map((l) => ({ ...l, discount: { type: 'percent' as const, basisPoints: coupon.percentBps } })));
  return { priced, coupon };
}

export interface TradeTerms { id: string; priceListId: string; creditLimitMinor: bigint; paymentTermsDays: number }

/** The customer's approved trade account for this store, if any. `lock` serialises concurrent checkouts on the account. */
export async function approvedTrade(tx: Pick<Db, 'query'>, storefrontId: string, customerId: string | null, lock = false): Promise<TradeTerms | null> {
  if (!customerId) return null;
  const { rows } = await tx.query<{ id: string; price_list_id: string; credit_limit_minor: string; payment_terms_days: number }>(
    `SELECT id, price_list_id, credit_limit_minor, payment_terms_days FROM trade_accounts
      WHERE storefront_id = $1 AND customer_id = $2 AND status = 'approved' ${lock ? 'FOR UPDATE' : ''}`,
    [storefrontId, customerId],
  );
  const t = rows[0];
  return t ? { id: t.id, priceListId: t.price_list_id, creditLimitMinor: BigInt(t.credit_limit_minor), paymentTermsDays: t.payment_terms_days } : null;
}

/** What the customer owes on orders placed on account (not cancelled), in minor units. */
export async function creditUsed(tx: Pick<Db, 'query'>, customerId: string): Promise<bigint> {
  const { rows } = await tx.query<{ owed: string }>(
    `SELECT COALESCE(sum(total_minor - paid_minor), 0) AS owed FROM sales_orders
      WHERE customer_id = $1 AND payment_method = 'account' AND status NOT IN ('cancelled', 'expired')`,
    [customerId],
  );
  return BigInt(rows[0]!.owed);
}

/** Only published, active products of this storefront can be bought, whatever the client sends. */
async function sellableTitles(tx: Pick<Db, 'query'>, sf: Storefront, ids: string[]): Promise<Map<string, string>> {
  const sellable = await tx.query<{ variant_id: string; title: string }>(
    `SELECT v.id AS variant_id, sp.title || CASE WHEN v.attributes <> '{}'::jsonb THEN ' (' || v.sku || ')' ELSE '' END AS title
       FROM product_variants v JOIN storefront_products sp ON sp.product_id = v.product_id AND sp.storefront_id = $1 AND sp.published
       JOIN products p ON p.id = v.product_id AND p.status = 'active'
      WHERE v.id = ANY($2::uuid[]) AND v.status = 'active' AND v.organization_id = $3`,
    [sf.id, ids, sf.organizationId],
  );
  const titles = new Map(sellable.rows.map((r) => [r.variant_id, r.title]));
  for (const id of ids) if (!titles.has(id)) throw invalid('An item in your basket is no longer available', { key: 'err.basket.gone' });
  return titles;
}

/**
 * What the basket would cost right now, without holding anything: the same pricing as checkout, plus whether each line
 * is in stock and, when a place is given, the delivery fee. The basket page shows this so no total is ever computed by the browser.
 */
export async function quoteBasket(db: Db, sf: Storefront, lines: PlaceOrderInput['lines'], to?: { countryCode: string; state: string }, couponCode?: string, customerId: string | null = null) {
  const ids = lines.map((l) => l.variantId);
  if (new Set(ids).size !== ids.length) throw invalid('Each product variant can appear once', { key: 'err.basket.duplicate' });
  return withTx(db, async (tx) => {
    const titles = await sellableTitles(tx, sf, ids);
    const trade = await approvedTrade(tx, sf.id, customerId);
    const { priced, coupon } = await priceWithCoupon(tx, trade ? { ...sf, priceListId: trade.priceListId } : sf, lines, couponCode, customerId, false);
    const stock = await availability(tx as unknown as Db, sf, ids);
    const out = priced.map((l) => {
      const have = toScaled(stock.get(l.variantId) ?? '0');
      return {
        variantId: l.variantId, sku: l.sku, title: titles.get(l.variantId)!, quantity: l.quantity, unitPrice: l.unitPrice,
        totalMinor: Number(l.p.total), inStock: have >= toScaled(l.quantity), available: Number(fromScaled(have > toScaled('100') ? toScaled('100') : have)),
      };
    });
    const totals = saleTotals(priced);
    const delivery = to ? await quoteDelivery(tx, sf, to.countryCode, to.state, totals.total) : null;
    const deliveryFee = BigInt(delivery?.feeMinor ?? 0);
    return {
      currency: sf.currency, lines: out, subtotalMinor: Number(totals.total), taxMinor: Number(totals.tax),
      discountMinor: Number(totals.discount), coupon: coupon ? { code: coupon.code, percentBps: coupon.percentBps } : null,
      delivery, deliveryFeeMinor: delivery ? Number(deliveryFee) : null, totalMinor: delivery ? Number(totals.total + deliveryFee) : null,
      allInStock: out.every((l) => l.inStock),
      trade: trade ? { creditAvailableMinor: Number(trade.creditLimitMinor - (customerId ? await creditUsed(tx, customerId) : 0n)) } : null,
    };
  });
}

export async function placeOrder(db: Db, sf: Storefront, customerId: string, input: PlaceOrderInput, clientKey: string, requestId?: string) {
  const hash = createHash('sha256').update(stable(input)).digest('hex');
  // Holds that have run out are returned first, so a shopper is not told 'sold out' because of abandoned checkouts.
  await expireUnpaidOrders(db);
  const outcome = await withTx(db, async (tx) => {
    // Serialises one shopper's checkouts, so a double-tap or retry meets the first attempt's result.
    const cust = await tx.query<{ full_name: string; email: string; phone: string | null }>('SELECT full_name, email, phone FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
    const customer = cust.rows[0]!;
    const prior = await tx.query<{ id: string; request_hash: string }>('SELECT id, request_hash FROM sales_orders WHERE customer_id = $1 AND client_key = $2', [customerId, clientKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== hash) throw invalid('Idempotency-Key was already used for a different order');
      return { orderId: prior.rows[0].id, replayed: true };
    }

    if (input.quoteNo && input.couponCode) throw invalid('A coupon cannot be used on a quoted order', { key: 'err.quote.coupon' });
    const fixed = input.quoteNo ? await quoteForOrder(tx, sf, customerId, input.quoteNo) : null;
    const orderLines = fixed ? fixed.priced.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) : input.lines;
    const ids = orderLines.map((l) => l.variantId);
    if (new Set(ids).size !== ids.length) throw invalid('Each product variant can appear on an order once; adjust its quantity instead', { key: 'err.order.duplicate' });

    const addr = await tx.query<{ recipient: string; phone: string; line1: string; line2: string | null; city: string; state: string; country_code: string }>(
      'SELECT recipient, phone, line1, line2, city, state, country_code FROM customer_addresses WHERE id = $1 AND customer_id = $2',
      [input.addressId, customerId],
    );
    const address = addr.rows[0];
    if (!address) throw invalid('Choose one of your saved delivery addresses', { key: 'err.address.choose' });

    const titles = fixed ? new Map(fixed.priced.map((l) => [l.variantId, l.title])) : await sellableTitles(tx, sf, ids);

    const now = new Date();
    const trade = await approvedTrade(tx, sf.id, customerId, true);
    if (fixed && !trade) throw conflict('Your trade account is on hold, so this quote cannot be accepted', { key: 'err.quote.hold' });
    if (input.paymentMethod === 'account' && !trade) throw invalid('Your business does not have an approved trade account', { key: 'err.trade.none' });
    const { priced, coupon } = fixed ? { priced: fixed.priced as PricedSaleLine[], coupon: null as CouponInfo | null } : await priceWithCoupon(tx, trade ? { ...sf, priceListId: trade.priceListId } : sf, input.lines, input.couponCode, customerId, true);

    const orderId = crypto.randomUUID();
    const shortages: unknown[] = [];
    const reservations: Alloc[][] = [];
    for (const l of priced) {
      const { allocs, missing } = await allocate(tx, sf, l.variantId, l.quantity);
      if (toScaled(missing) > 0n) shortages.push({ variantId: l.variantId, sku: l.sku, requested: l.quantity, available: fromScaled(toScaled(l.quantity) - toScaled(missing)) });
      reservations.push(allocs);
    }
    if (shortages.length) throw shortage('Some items are no longer available in the quantity you asked for', shortages, { key: 'err.shortage' });

    const totals = saleTotals(priced);
    const linesTotal = totals.total;
    const quote = await quoteDelivery(tx, sf, address.country_code, address.state, linesTotal);
    const deliveryFee = BigInt(quote.feeMinor);
    const total = linesTotal + deliveryFee;
    if (total <= 0n) throw invalid('This order has no value', { key: 'err.order.noValue' });

    const onAccount = input.paymentMethod === 'account';
    if (onAccount) {
      const used = await creditUsed(tx, customerId);
      if (used + total > trade!.creditLimitMinor) { const available = trade!.creditLimitMinor - used > 0n ? trade!.creditLimitMinor - used : 0n; throw invalid(`This order would take you over your credit limit (available: ${available} minor units)`, { key: 'err.credit', vars: { available } }); };
    }
    const expiresAt = new Date(now.getTime() + (input.paymentMethod === 'account' ? 30 * 24 * 60 : ORDER_HOLD_MINUTES[input.paymentMethod]) * 60_000);
    const dueOn = onAccount ? new Date(now.getTime() + trade!.paymentTermsDays * 86_400_000).toISOString().slice(0, 10) : null;
    
    const orderNo = await nextDocumentNumber(tx, sf.organizationId, sf.legalEntityId, 'sales_order', 'SO');
    const contact = { name: customer.full_name, email: customer.email, phone: address.phone || customer.phone };
    const delivery = {
      recipient: address.recipient, phone: address.phone, line1: address.line1, line2: address.line2, city: address.city, state: address.state,
      countryCode: address.country_code.trim(), zone: quote.zone, etaDays: quote.etaDays,
    };
    await tx.query(
      `INSERT INTO sales_orders (id, organization_id, legal_entity_id, storefront_id, customer_id, order_no, status, currency, subtotal_minor, tax_minor,
                                 delivery_fee_minor, total_minor, payment_method, contact, delivery, note, client_key, request_hash, expires_at, discount_minor, coupon_id, due_on)
       VALUES ($1,$2,$3,$4,$5,$6,$21,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$22)`,
      [orderId, sf.organizationId, sf.legalEntityId, sf.id, customerId, orderNo, sf.currency, linesTotal, totals.tax, deliveryFee, total, input.paymentMethod,
       JSON.stringify(contact), JSON.stringify(delivery), input.note ?? null, clientKey, hash, expiresAt, totals.discount, coupon?.id ?? null, onAccount ? 'confirmed' : 'pending_payment', dueOn],
    );
    for (const [i, l] of priced.entries()) {
      await tx.query(
        `INSERT INTO sales_order_lines (order_id, line_no, variant_id, sku, title, quantity, unit_price, tax_code, tax_rate, tax_inclusive, gross_minor, tax_minor, total_minor, discount_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [orderId, i + 1, l.variantId, l.sku, titles.get(l.variantId), l.quantity, l.unitPrice, l.tax?.code ?? null, l.tax?.rate ?? null, l.tax?.inclusive ?? null, l.p.gross, l.p.tax, l.p.total, l.p.discount],
      );
      for (const a of reservations[i]!) {
        await createReservation(tx, { organizationId: sf.organizationId, userId: null, locationId: a.locationId, variantId: l.variantId, lotId: a.lotId, quantity: a.quantity, referenceType: 'sales_order', referenceId: orderId });
      }
    }
    const actor: Actor = { type: 'customer', id: customerId };
    if (fixed) {
      await tx.query(`UPDATE quotes SET status = 'accepted', decided_at = now(), order_id = $2 WHERE id = $1`, [fixed.id, orderId]);
      await tx.query('UPDATE sales_orders SET quote_id = $2 WHERE id = $1', [orderId, fixed.id]);
    }
    await addEvent(tx, orderId, onAccount ? 'confirmed' : 'pending_payment', actor, [fixed ? `Placed from quote ${input.quoteNo}` : '', onAccount ? `On account, payment due ${dueOn}` : ''].filter(Boolean).join('. ') || undefined);
    await audit(tx, sf.organizationId, actor, 'order.place', orderId, { orderNo, totalMinor: Number(total), paymentMethod: input.paymentMethod }, requestId);
    return { orderId, replayed: false };
  });
  return { order: await readOrder(db, { id: outcome.orderId, customerId, organizationId: sf.organizationId }), replayed: outcome.replayed };
}

export async function lockOrder(tx: Tx, organizationId: string, where: { id?: string; orderNo?: string; customerId?: string }) {
  const { rows } = await tx.query<{ id: string; status: string; legal_entity_id: string; total_minor: string; paid_minor: string; payment_method: string }>(
    `SELECT id, status, legal_entity_id, total_minor, paid_minor, payment_method FROM sales_orders
      WHERE organization_id = $1 AND ($2::uuid IS NULL OR id = $2) AND ($3::text IS NULL OR order_no = $3) AND ($4::uuid IS NULL OR customer_id = $4) FOR UPDATE`,
    [organizationId, where.id ?? null, where.orderNo ?? null, where.customerId ?? null],
  );
  if (!rows[0]) throw notFound('Order');
  return rows[0];
}

export async function cancelOrder(db: Db, organizationId: string, where: { id?: string; orderNo?: string; customerId?: string }, actor: Actor, reason: string, requestId?: string) {
  const id = await withTx(db, async (tx) => {
    const o = await lockOrder(tx, organizationId, where);
    const allowed = actor.type === 'customer' ? ['pending_payment'] : ['pending_payment', 'confirmed', 'paid', 'processing'];
    if (!allowed.includes(o.status)) throw conflict(`An order that is ${o.status.replace('_', ' ')} can no longer be cancelled${actor.type === 'customer' ? ' here; contact the store' : ''}`, { key: actor.type === 'customer' ? 'err.order.cancelContact' : 'err.order.cancel', vars: { status: statusWord(o.status) } });
    await releaseReferenceReservations(tx, 'sales_order', o.id);
    await tx.query(
      `UPDATE sales_orders SET status = 'cancelled', cancel_reason = $2, refund_due_minor = paid_minor, closed_at = now() WHERE id = $1`,
      [o.id, reason],
    );
    await addEvent(tx, o.id, 'cancelled', actor, reason);
    await audit(tx, organizationId, actor, 'order.cancel', o.id, { reason, refundDueMinor: Number(o.paid_minor) }, requestId);
    return o.id;
  });
  return readOrder(db, { id, organizationId }, actor.type === 'staff');
}

/**
 * Books a payment against a locked order inside the caller's transaction. A payment for an order that is awaiting
 * payment settles it. A payment that arrives for an order already closed or paid is kept on the order and the same
 * amount is recorded as owed back, so money is never silently lost or silently kept.
 */
export async function applyPayment(
  tx: Tx, organizationId: string, o: Awaited<ReturnType<typeof lockOrder>>,
  p: { method: 'card' | 'bank_transfer'; provider?: string | null; reference: string; amountMinor: number }, actor: Actor, requestId?: string,
): Promise<'settled' | 'refund_due'> {
  const outstanding = BigInt(o.total_minor) - BigInt(o.paid_minor);
  if (o.payment_method === 'account') {
    // On-account orders are settled by one or more payments against the balance; the order's status does not change.
    if (['cancelled', 'expired'].includes(o.status)) throw conflict(`Payment cannot be recorded on an order that is ${o.status}`);
    if (BigInt(p.amountMinor) > outstanding) throw invalid(`The payment is more than the balance owing (${outstanding})`);
    try {
      await tx.query('INSERT INTO sales_order_payments (order_id, method, provider, reference, amount_minor, recorded_by) VALUES ($1,$2,$3,$4,$5,$6)',
        [o.id, p.method, p.provider ?? null, p.reference, p.amountMinor, actor.type === 'staff' ? actor.id : null]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('That payment reference has already been used');
      throw err;
    }
    await tx.query('UPDATE sales_orders SET paid_minor = paid_minor + $2 WHERE id = $1', [o.id, p.amountMinor]);
    await addEvent(tx, o.id, o.status, actor, `Payment of ${p.amountMinor} received (${p.method} ${p.reference})`);
    await audit(tx, organizationId, actor, 'order.account_payment', o.id, { method: p.method, amountMinor: p.amountMinor }, requestId);
    return 'settled';
  }
  const settles = o.status === 'pending_payment';
  if (settles && BigInt(p.amountMinor) !== outstanding) throw invalid(`The amount must equal the amount outstanding (${outstanding})`);
  try {
    await tx.query(
      'INSERT INTO sales_order_payments (order_id, method, provider, reference, amount_minor, recorded_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [o.id, p.method, p.provider ?? null, p.reference, p.amountMinor, actor.type === 'staff' ? actor.id : null],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('That payment reference has already been used');
    throw err;
  }
  if (settles) {
    await tx.query(`UPDATE sales_orders SET paid_minor = paid_minor + $2, status = 'paid', paid_at = now() WHERE id = $1`, [o.id, p.amountMinor]);
    await addEvent(tx, o.id, 'paid', actor, `${p.method} ${p.reference}`);
    await audit(tx, organizationId, actor, 'order.payment', o.id, { method: p.method, amountMinor: p.amountMinor }, requestId);
    return 'settled';
  }
  await tx.query(`UPDATE sales_orders SET paid_minor = paid_minor + $2, refund_due_minor = refund_due_minor + $2 WHERE id = $1`, [o.id, p.amountMinor]);
  await addEvent(tx, o.id, o.status, actor, `Payment of ${p.amountMinor} received after the order was ${o.status.replace('_', ' ')}; refund owed`);
  await audit(tx, organizationId, actor, 'order.payment_late', o.id, { method: p.method, amountMinor: p.amountMinor }, requestId);
  return 'refund_due';
}

export async function recordPayment(
  db: Db, organizationId: string, orderId: string,
  p: { method: 'card' | 'bank_transfer'; provider?: string | null; reference: string; amountMinor: number }, actor: Actor, requestId?: string,
) {
  await withTx(db, async (tx) => {
    const o = await lockOrder(tx, organizationId, { id: orderId });
    // Staff confirm money for orders that are waiting for it; late card money is handled by the provider path only.
    if (o.status !== 'pending_payment' && o.payment_method !== 'account') throw conflict(`Payment cannot be recorded on an order that is ${o.status.replace('_', ' ')}`);
    await applyPayment(tx, organizationId, o, p, actor, requestId);
  });
  return readOrder(db, { id: orderId, organizationId }, true);
}

const TRANSITIONS = { process: { from: ['paid', 'confirmed'], to: 'processing' }, ship: { from: ['paid', 'confirmed', 'processing'], to: 'shipped' }, deliver: { from: ['shipped'], to: 'delivered' } } as const;

export async function advanceOrder(
  db: Db, organizationId: string, orderId: string, action: keyof typeof TRANSITIONS,
  extra: { carrier?: string; trackingRef?: string; note?: string; shipment?: { carrierId?: string | null; externalId?: string | null; labelUrl?: string | null; eta?: string | null } }, actor: Actor, requestId?: string,
) {
  await withTx(db, async (tx) => {
    const o = await lockOrder(tx, organizationId, { id: orderId });
    const t = TRANSITIONS[action];
    if (!(t.from as readonly string[]).includes(o.status)) throw conflict(`Cannot ${action} an order that is ${o.status.replace('_', ' ')}`);
    if (action === 'ship') {
      // Stock leaves the shelf when the parcel does.
      await fulfilReferenceReservations(tx, { organizationId, actorUserId: actor.id!, requestId }, 'sales_order', o.id, 'shipment');
    }
    await tx.query(
      `UPDATE sales_orders SET status = $2, carrier = COALESCE($3, carrier), tracking_ref = COALESCE($4, tracking_ref),
              shipped_at = CASE WHEN $2 = 'shipped' THEN now() ELSE shipped_at END,
              delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END,
              closed_at = CASE WHEN $2 = 'delivered' THEN now() ELSE closed_at END
        WHERE id = $1`,
      [o.id, t.to, extra.carrier ?? null, extra.trackingRef ?? null],
    );
    if (action === 'ship') await recordShipment(tx, organizationId, o.id, { carrierName: extra.carrier ?? 'Courier', trackingRef: extra.trackingRef, ...extra.shipment });
    await addEvent(tx, o.id, t.to, actor, extra.note);
    await audit(tx, organizationId, actor, `order.${action}`, o.id, { carrier: extra.carrier, trackingRef: extra.trackingRef }, requestId);
  });
  return readOrder(db, { id: orderId, organizationId }, true);
}

/** Cancels unpaid orders whose hold has run out and gives the stock back. Safe to run concurrently. */
export async function expireUnpaidOrders(db: Db, now = new Date(), batch = 100): Promise<number> {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query<{ id: string; organization_id: string }>(
      `SELECT id, organization_id FROM sales_orders WHERE status = 'pending_payment' AND expires_at <= $1
        ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, batch],
    );
    for (const o of rows) {
      await releaseReferenceReservations(tx, 'sales_order', o.id);
      await tx.query(`UPDATE sales_orders SET status = 'expired', closed_at = now() WHERE id = $1`, [o.id]);
      const actor: Actor = { type: 'system', id: null };
      await addEvent(tx, o.id, 'expired', actor, 'Payment was not received in time');
      await audit(tx, o.organization_id, actor, 'order.expire', o.id, {});
    }
    return rows.length;
  });
}

/** The customer's running account: what was ordered on account and what was paid, oldest first, with the balance after each line. */
export async function tradeStatement(db: Pick<Db, 'query'>, customerId: string) {
  const { rows } = await db.query<{ at: Date; kind: string; ref: string; amount: string }>(
    `SELECT o.placed_at AS at, 'order' AS kind, o.order_no AS ref, o.total_minor AS amount FROM sales_orders o
      WHERE o.customer_id = $1 AND o.payment_method = 'account' AND o.status NOT IN ('cancelled', 'expired')
     UNION ALL
     SELECT p.created_at, 'payment', p.reference, p.amount_minor FROM sales_order_payments p JOIN sales_orders o ON o.id = p.order_id
      WHERE o.customer_id = $1 AND o.payment_method = 'account' AND o.status NOT IN ('cancelled', 'expired')
     ORDER BY at, kind DESC`,
    [customerId],
  );
  let balance = 0n;
  return rows.map((r) => {
    const amount = BigInt(r.amount);
    balance += r.kind === 'order' ? amount : -amount;
    return { at: r.at, kind: r.kind, reference: r.ref, amountMinor: Number(amount), balanceMinor: Number(balance) };
  });
}
