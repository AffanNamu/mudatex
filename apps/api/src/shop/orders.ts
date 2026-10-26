import { createHash } from 'node:crypto';
import { writeAudit } from '../audit.js';
import { nextDocumentNumber } from '../documents.js';
import { withTx, type Db, type Tx } from '../db.js';
import { fromScaled, normalize, toScaled } from '../domain/decimal.js';
import { conflict, invalid, notFound, shortage } from '../errors.js';
import { stable } from '../idempotency.js';
import { fulfilReferenceReservations, createReservation, releaseReferenceReservations } from '../inventory/service.js';
import { priceSaleLines, saleTotals } from '../pos/pricing.js';
import { quoteDelivery, type Storefront } from './catalog.js';

export const ORDER_HOLD_MINUTES = { card: 60, bank_transfer: 24 * 60 } as const;
export const MAX_ORDER_LINES = 50;

export interface PlaceOrderInput {
  lines: { variantId: string; quantity: string; unitId?: string }[];
  addressId: string;
  paymentMethod: 'card' | 'bank_transfer';
  note?: string;
}

export type Actor = { type: 'customer'; id: string } | { type: 'staff'; id: string } | { type: 'system'; id: null };

const ORDER_COLUMNS = `o.id, o.order_no AS "orderNo", o.status, o.currency, o.subtotal_minor AS "subtotalMinor", o.tax_minor AS "taxMinor",
  o.delivery_fee_minor AS "deliveryFeeMinor", o.total_minor AS "totalMinor", o.paid_minor AS "paidMinor", o.refund_due_minor AS "refundDueMinor",
  o.payment_method AS "paymentMethod", o.contact, o.delivery, o.note, o.carrier, o.tracking_ref AS "trackingRef", o.cancel_reason AS "cancelReason",
  o.expires_at AS "expiresAt", o.placed_at AS "placedAt", o.paid_at AS "paidAt", o.shipped_at AS "shippedAt", o.delivered_at AS "deliveredAt"`;

const MONEY_FIELDS = ['subtotalMinor', 'taxMinor', 'deliveryFeeMinor', 'totalMinor', 'paidMinor', 'refundDueMinor'] as const;
const asNumbers = <T extends Record<string, any>>(row: T): T => {
  const out: Record<string, any> = { ...row };
  for (const f of MONEY_FIELDS) if (f in out) out[f] = Number(out[f]);
  return out as T;
};

export async function readOrder(q: Pick<Db, 'query'>, where: { id?: string; orderNo?: string; customerId?: string; organizationId: string }, withPayments = false) {
  const { rows } = await q.query(
    `SELECT ${ORDER_COLUMNS}, o.customer_id AS "customerId", o.legal_entity_id AS "legalEntityId", o.storefront_id AS "storefrontId"
       FROM sales_orders o
      WHERE o.organization_id = $1 AND ($2::uuid IS NULL OR o.id = $2) AND ($3::text IS NULL OR o.order_no = $3) AND ($4::uuid IS NULL OR o.customer_id = $4)`,
    [where.organizationId, where.id ?? null, where.orderNo ?? null, where.customerId ?? null],
  );
  if (!rows[0]) throw notFound('Order');
  const order = asNumbers(rows[0]);
  const lines = await q.query(
    `SELECT line_no AS "lineNo", variant_id AS "variantId", sku, title, quantity, unit_price AS "unitPrice", tax_code AS "taxCode",
            gross_minor AS "grossMinor", tax_minor AS "taxMinor", total_minor AS "totalMinor"
       FROM sales_order_lines WHERE order_id = $1 ORDER BY line_no`,
    [order.id],
  );
  const events = await q.query(`SELECT status, actor_type AS "actorType", note, at FROM sales_order_events WHERE order_id = $1 ORDER BY id`, [order.id]);
  const result: Record<string, unknown> = {
    ...order,
    lines: lines.rows.map((l) => ({ ...l, quantity: normalize(l.quantity), unitPrice: normalize(l.unitPrice), grossMinor: Number(l.grossMinor), taxMinor: Number(l.taxMinor), totalMinor: Number(l.totalMinor) })),
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

    const ids = input.lines.map((l) => l.variantId);
    if (new Set(ids).size !== ids.length) throw invalid('Each product variant can appear on an order once; adjust its quantity instead');

    const addr = await tx.query<{ recipient: string; phone: string; line1: string; line2: string | null; city: string; state: string; country_code: string }>(
      'SELECT recipient, phone, line1, line2, city, state, country_code FROM customer_addresses WHERE id = $1 AND customer_id = $2',
      [input.addressId, customerId],
    );
    const address = addr.rows[0];
    if (!address) throw invalid('Choose one of your saved delivery addresses');

    // Only published, active products of this storefront can be bought, whatever the client sends.
    const sellable = await tx.query<{ variant_id: string; title: string }>(
      `SELECT v.id AS variant_id, sp.title || CASE WHEN v.attributes <> '{}'::jsonb THEN ' (' || v.sku || ')' ELSE '' END AS title
         FROM product_variants v JOIN storefront_products sp ON sp.product_id = v.product_id AND sp.storefront_id = $1 AND sp.published
         JOIN products p ON p.id = v.product_id AND p.status = 'active'
        WHERE v.id = ANY($2::uuid[]) AND v.status = 'active' AND v.organization_id = $3`,
      [sf.id, ids, sf.organizationId],
    );
    const titles = new Map(sellable.rows.map((r) => [r.variant_id, r.title]));
    for (const id of ids) if (!titles.has(id)) throw invalid('An item in your basket is no longer available');

    const now = new Date();
    const priced = await priceSaleLines(
      tx,
      { organizationId: sf.organizationId, priceListId: sf.priceListId, minorUnit: sf.minorUnit, maxDiscountBps: 0, mayOverride: false, lotsOptional: true, now },
      input.lines,
    );

    const orderId = crypto.randomUUID();
    const shortages: unknown[] = [];
    const reservations: Alloc[][] = [];
    for (const l of priced) {
      const { allocs, missing } = await allocate(tx, sf, l.variantId, l.quantity);
      if (toScaled(missing) > 0n) shortages.push({ variantId: l.variantId, sku: l.sku, requested: l.quantity, available: fromScaled(toScaled(l.quantity) - toScaled(missing)) });
      reservations.push(allocs);
    }
    if (shortages.length) throw shortage('Some items are no longer available in the quantity you asked for', shortages);

    const totals = saleTotals(priced);
    const linesTotal = totals.total;
    const quote = await quoteDelivery(tx, sf, address.country_code, address.state, linesTotal);
    const deliveryFee = BigInt(quote.feeMinor);
    const total = linesTotal + deliveryFee;
    if (total <= 0n) throw invalid('This order has no value');

    const expiresAt = new Date(now.getTime() + ORDER_HOLD_MINUTES[input.paymentMethod] * 60_000);
    
    const orderNo = await nextDocumentNumber(tx, sf.organizationId, sf.legalEntityId, 'sales_order', 'SO');
    const contact = { name: customer.full_name, email: customer.email, phone: address.phone || customer.phone };
    const delivery = {
      recipient: address.recipient, phone: address.phone, line1: address.line1, line2: address.line2, city: address.city, state: address.state,
      countryCode: address.country_code.trim(), zone: quote.zone, etaDays: quote.etaDays,
    };
    await tx.query(
      `INSERT INTO sales_orders (id, organization_id, legal_entity_id, storefront_id, customer_id, order_no, status, currency, subtotal_minor, tax_minor,
                                 delivery_fee_minor, total_minor, payment_method, contact, delivery, note, client_key, request_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending_payment',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [orderId, sf.organizationId, sf.legalEntityId, sf.id, customerId, orderNo, sf.currency, linesTotal, totals.tax, deliveryFee, total, input.paymentMethod,
       JSON.stringify(contact), JSON.stringify(delivery), input.note ?? null, clientKey, hash, expiresAt],
    );
    for (const [i, l] of priced.entries()) {
      await tx.query(
        `INSERT INTO sales_order_lines (order_id, line_no, variant_id, sku, title, quantity, unit_price, tax_code, tax_rate, tax_inclusive, gross_minor, tax_minor, total_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [orderId, i + 1, l.variantId, l.sku, titles.get(l.variantId), l.quantity, l.unitPrice, l.tax?.code ?? null, l.tax?.rate ?? null, l.tax?.inclusive ?? null, l.p.gross, l.p.tax, l.p.total],
      );
      for (const a of reservations[i]!) {
        await createReservation(tx, { organizationId: sf.organizationId, userId: null, locationId: a.locationId, variantId: l.variantId, lotId: a.lotId, quantity: a.quantity, referenceType: 'sales_order', referenceId: orderId });
      }
    }
    const actor: Actor = { type: 'customer', id: customerId };
    await addEvent(tx, orderId, 'pending_payment', actor);
    await audit(tx, sf.organizationId, actor, 'order.place', orderId, { orderNo, totalMinor: Number(total), paymentMethod: input.paymentMethod }, requestId);
    return { orderId, replayed: false };
  });
  return { order: await readOrder(db, { id: outcome.orderId, customerId, organizationId: sf.organizationId }), replayed: outcome.replayed };
}

async function lockOrder(tx: Tx, organizationId: string, where: { id?: string; orderNo?: string; customerId?: string }) {
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
    const allowed = actor.type === 'customer' ? ['pending_payment'] : ['pending_payment', 'paid', 'processing'];
    if (!allowed.includes(o.status)) throw conflict(`An order that is ${o.status.replace('_', ' ')} can no longer be cancelled${actor.type === 'customer' ? ' here; contact the store' : ''}`);
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

export async function recordPayment(
  db: Db, organizationId: string, orderId: string,
  p: { method: 'card' | 'bank_transfer'; provider?: string | null; reference: string; amountMinor: number }, actor: Actor, requestId?: string,
) {
  await withTx(db, async (tx) => {
    const o = await lockOrder(tx, organizationId, { id: orderId });
    if (o.status !== 'pending_payment') throw conflict(`Payment cannot be recorded on an order that is ${o.status.replace('_', ' ')}`);
    const outstanding = BigInt(o.total_minor) - BigInt(o.paid_minor);
    if (BigInt(p.amountMinor) !== outstanding) throw invalid(`The amount must equal the amount outstanding (${outstanding})`);
    try {
      await tx.query(
        'INSERT INTO sales_order_payments (order_id, method, provider, reference, amount_minor, recorded_by) VALUES ($1,$2,$3,$4,$5,$6)',
        [o.id, p.method, p.provider ?? null, p.reference, p.amountMinor, actor.type === 'staff' ? actor.id : null],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('That payment reference has already been used');
      throw err;
    }
    await tx.query(`UPDATE sales_orders SET paid_minor = paid_minor + $2, status = 'paid', paid_at = now() WHERE id = $1`, [o.id, p.amountMinor]);
    await addEvent(tx, o.id, 'paid', actor, `${p.method} ${p.reference}`);
    await audit(tx, organizationId, actor, 'order.payment', o.id, { method: p.method, amountMinor: p.amountMinor }, requestId);
  });
  return readOrder(db, { id: orderId, organizationId }, true);
}

const TRANSITIONS = { process: { from: ['paid'], to: 'processing' }, ship: { from: ['paid', 'processing'], to: 'shipped' }, deliver: { from: ['shipped'], to: 'delivered' } } as const;

export async function advanceOrder(
  db: Db, organizationId: string, orderId: string, action: keyof typeof TRANSITIONS,
  extra: { carrier?: string; trackingRef?: string; note?: string }, actor: Actor, requestId?: string,
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
