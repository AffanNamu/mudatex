import type { Db } from '../db.js';
import { normalize } from '../domain/decimal.js';
import { notFound } from '../errors.js';

export interface OrderDocument {
  orderNo: string; status: string; issuedOn: string; dueOn: string | null; currency: string; minorUnit: number; paymentMethod: string;
  seller: { name: string; legalName: string; address: string | null; phone: string | null; email: string | null; taxId: string | null; footer: string | null };
  buyer: { name: string; email: string; phone: string | null; businessName: string | null; taxId: string | null };
  deliveryTo: { recipient: string; line1: string; line2: string | null; city: string; state: string; countryCode: string };
  lines: { title: string; sku: string; quantity: string; unitPrice: string; taxCode: string | null; taxRatePct: string | null; taxInclusive: boolean | null; discountMinor: number; taxMinor: number; totalMinor: number }[];
  taxSummary: { taxCode: string; ratePct: string; taxableMinor: number; taxMinor: number }[];
  goodsMinor: number; discountMinor: number; couponCode: string | null; deliveryFeeMinor: number; totalMinor: number;
  payments: { at: string; method: string; reference: string; amountMinor: number }[];
  refunds: { at: string; method: string; amountMinor: number }[];
  paidMinor: number; refundedMinor: number; balanceMinor: number;
  bank: { bankName: string | null; accountName: string | null; accountNumber: string | null } | null;
}

/**
 * Everything printed on an order's invoice or receipt, read from what was recorded when the order was placed and paid.
 * Nothing is recalculated here, so the paper can never disagree with the order.
 */
export async function orderDocument(db: Pick<Db, 'query'>, where: { id?: string; orderNo?: string; customerId?: string; organizationId: string }): Promise<OrderDocument & { legalEntityId: string }> {
  const { rows } = await db.query(
    `SELECT o.id, o.order_no AS "orderNo", o.status, to_char(o.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "issuedOn", to_char(o.due_on, 'YYYY-MM-DD') AS "dueOn", o.currency, cu.minor_unit AS "minorUnit",
            o.payment_method AS "paymentMethod", o.subtotal_minor::float8 AS "goodsMinor", o.discount_minor::float8 AS "discountMinor", (SELECT code FROM coupons WHERE id = o.coupon_id) AS "couponCode",
            o.delivery_fee_minor::float8 AS "deliveryFeeMinor", o.total_minor::float8 AS "totalMinor", o.paid_minor::float8 AS "paidMinor", o.contact, o.delivery,
            s.name AS "storeName", s.contact AS "storeContact", e.name AS "legalName", o.legal_entity_id AS "legalEntityId",
            (SELECT business_name FROM trade_accounts t WHERE t.storefront_id = o.storefront_id AND t.customer_id = o.customer_id AND t.status IN ('approved', 'suspended')) AS "businessName",
            (SELECT tax_id FROM trade_accounts t WHERE t.storefront_id = o.storefront_id AND t.customer_id = o.customer_id AND t.status IN ('approved', 'suspended')) AS "businessTaxId"
       FROM sales_orders o JOIN currencies cu ON cu.code = o.currency JOIN storefronts s ON s.id = o.storefront_id JOIN legal_entities e ON e.id = o.legal_entity_id
      WHERE o.organization_id = $1 AND ($2::uuid IS NULL OR o.id = $2) AND ($3::text IS NULL OR o.order_no = $3) AND ($4::uuid IS NULL OR o.customer_id = $4)`,
    [where.organizationId, where.id ?? null, where.orderNo ?? null, where.customerId ?? null],
  );
  const o = rows[0];
  if (!o) throw notFound('Order');
  const lines = await db.query(
    `SELECT title, sku, quantity, unit_price AS "unitPrice", tax_code AS "taxCode", tax_rate AS "taxRate", tax_inclusive AS "taxInclusive",
            discount_minor::float8 AS "discountMinor", tax_minor::float8 AS "taxMinor", total_minor::float8 AS "totalMinor"
       FROM sales_order_lines WHERE order_id = $1 ORDER BY line_no`,
    [o.id],
  );
  const payments = await db.query('SELECT created_at AS at, method, reference, amount_minor::float8 AS "amountMinor" FROM sales_order_payments WHERE order_id = $1 ORDER BY created_at, id', [o.id]);
  const refunds = await db.query(`SELECT COALESCE(settled_at, decided_at, created_at) AS at, method, amount_minor::float8 AS "amountMinor" FROM order_refunds WHERE order_id = $1 AND status = 'paid' ORDER BY created_at`, [o.id]);

  const pct = (rate: string | null) => (rate === null ? null : normalize(String(Number(rate) * 100)));
  const docLines = lines.rows.map((l) => ({ ...l, quantity: normalize(l.quantity), unitPrice: normalize(l.unitPrice), taxRatePct: pct(l.taxRate) }));
  const summary = new Map<string, { taxCode: string; ratePct: string; taxableMinor: number; taxMinor: number }>();
  for (const l of docLines) {
    if (!l.taxCode) continue;
    const key = `${l.taxCode}/${l.taxRatePct}`;
    const s = summary.get(key) ?? { taxCode: l.taxCode, ratePct: l.taxRatePct ?? '0', taxableMinor: 0, taxMinor: 0 };
    s.taxableMinor += l.totalMinor - l.taxMinor;
    s.taxMinor += l.taxMinor;
    summary.set(key, s);
  }
  const refundedMinor = refunds.rows.reduce((n, r) => n + r.amountMinor, 0);
  const c = o.storeContact as Record<string, string | undefined>;
  const balanceMinor = ['cancelled', 'expired'].includes(o.status) ? 0 : Math.max(0, o.totalMinor - o.paidMinor);
  return {
    legalEntityId: o.legalEntityId,
    orderNo: o.orderNo, status: o.status, issuedOn: o.issuedOn, dueOn: o.dueOn, currency: o.currency, minorUnit: o.minorUnit, paymentMethod: o.paymentMethod,
    seller: { name: o.storeName, legalName: o.legalName, address: c.address ?? null, phone: c.phone ?? null, email: c.email ?? null, taxId: c.taxId ?? null, footer: c.invoiceFooter ?? null },
    buyer: { name: o.contact.name, email: o.contact.email, phone: o.contact.phone ?? null, businessName: o.businessName, taxId: o.businessTaxId },
    deliveryTo: { recipient: o.delivery.recipient, line1: o.delivery.line1, line2: o.delivery.line2 ?? null, city: o.delivery.city, state: o.delivery.state, countryCode: o.delivery.countryCode },
    lines: docLines.map(({ taxRate: _t, ...l }) => l),
    taxSummary: [...summary.values()],
    goodsMinor: o.goodsMinor, discountMinor: o.discountMinor, couponCode: o.couponCode, deliveryFeeMinor: o.deliveryFeeMinor, totalMinor: o.totalMinor,
    payments: payments.rows, refunds: refunds.rows, paidMinor: o.paidMinor, refundedMinor, balanceMinor,
    bank: balanceMinor > 0 && c.accountNumber ? { bankName: c.bankName ?? null, accountName: c.accountName ?? null, accountNumber: c.accountNumber } : null,
  };
}
