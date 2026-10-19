import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, can, grantsFor } from '../auth/authorize.js';
import type { Db, Tx } from '../db.js';
import { normalize, toScaled } from '../domain/decimal.js';
import { priceSaleLines, saleTotals, type SaleLineInput } from '../pos/pricing.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { audit, quantityField, scopeFilter, uuid } from '../inventory/common.js';
import { postMovements, type Posting } from '../inventory/ledger.js';
import { createReservation, fulfilReferenceReservations, releaseReferenceReservations } from '../inventory/service.js';

const METHODS = ['cash', 'card', 'bank_transfer', 'mobile_money'] as const;

const discountBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('percent'), basisPoints: z.number().int().min(1).max(10000) }),
  z.object({ type: z.literal('amount'), amountMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }),
]);

const saleBody = z.object({
  registerId: uuid,
  lines: z
    .array(z.object({ variantId: uuid, lotId: uuid.optional(), quantity: quantityField, unitId: uuid.optional(), discount: discountBody.optional() }))
    .min(1)
    .max(100),
  payments: z
    .array(
      z.object({
        method: z.enum(METHODS),
        amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        tenderedMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
        reference: z.string().min(1).max(200).optional(),
      }),
    )
    .min(1)
    .max(10),
  /** What the terminal showed the customer. A mismatch means a price changed underneath the cashier. */
  expectedTotalMinor: z.number().int().positive().optional(),
  note: z.string().max(500).optional(),
  deviceId: z.string().max(100).optional(),
  clientTimestamp: z.string().datetime().optional(),
});

export async function readSale(db: Db | Tx, organizationId: string, id: string) {
  const s = await db.query(
    `SELECT id, register_id AS "registerId", session_id AS "sessionId", location_id AS "locationId",
            receipt_number AS "receiptNumber", status, currency, minor_unit AS "minorUnit",
            subtotal_minor AS "subtotalMinor", discount_minor AS "discountMinor", tax_minor AS "taxMinor", total_minor AS "totalMinor",
            cashier_id AS "cashierId", note, created_at AS "createdAt", completed_at AS "completedAt"
       FROM pos_sales WHERE id = $1 AND organization_id = $2`,
    [id, organizationId],
  );
  const sale = s.rows[0];
  if (!sale) throw notFound('Sale');
  const lines = await db.query(
    `SELECT l.id, l.line_no AS "lineNo", l.variant_id AS "variantId", v.sku, p.name AS "productName", l.lot_id AS "lotId", l.quantity,
            l.returned_quantity AS "returnedQuantity", l.unit_price AS "unitPrice", l.tax_code AS "taxCode", l.tax_rate AS "taxRate",
            l.tax_inclusive AS "taxInclusive", l.discount_bps AS "discountBps", l.gross_minor AS "grossMinor", l.discount_minor AS "discountMinor",
            l.tax_minor AS "taxMinor", l.total_minor AS "totalMinor"
       FROM pos_sale_lines l JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
      WHERE l.sale_id = $1 ORDER BY l.line_no`,
    [id],
  );
  const payments = await db.query(
    `SELECT id, method, amount_minor AS "amountMinor", tendered_minor AS "tenderedMinor", change_minor AS "changeMinor",
            reference, status, verified_at AS "verifiedAt"
       FROM pos_payments WHERE sale_id = $1 ORDER BY seq`,
    [id],
  );
  const returns = await db.query(
    `SELECT id, return_number AS "returnNumber", refund_method AS "refundMethod", refund_total_minor AS "refundTotalMinor",
            refund_status AS "refundStatus", created_at AS "createdAt"
       FROM pos_returns WHERE sale_id = $1 ORDER BY return_number`,
    [id],
  );
  const num = (v: unknown) => Number(v);
  return {
    ...sale,
    subtotalMinor: num(sale.subtotalMinor),
    discountMinor: num(sale.discountMinor),
    taxMinor: num(sale.taxMinor),
    totalMinor: num(sale.totalMinor),
    lines: lines.rows.map((l) => ({
      ...l,
      quantity: normalize(l.quantity),
      returnedQuantity: normalize(l.returnedQuantity),
      unitPrice: normalize(l.unitPrice),
      taxRate: normalize(l.taxRate),
      grossMinor: num(l.grossMinor),
      discountMinor: num(l.discountMinor),
      taxMinor: num(l.taxMinor),
      totalMinor: num(l.totalMinor),
    })),
    payments: payments.rows.map((p) => ({
      ...p,
      amountMinor: num(p.amountMinor),
      tenderedMinor: p.tenderedMinor === null ? null : num(p.tenderedMinor),
      changeMinor: p.changeMinor === null ? null : num(p.changeMinor),
    })),
    returns: returns.rows.map((r) => ({ ...r, refundTotalMinor: num(r.refundTotalMinor) })),
  };
}

interface SaleRef {
  id: string;
  status: string;
  location_id: string;
  cashier_id: string;
}

async function lockSale(tx: Tx, organizationId: string, id: string): Promise<SaleRef> {
  const { rows } = await tx.query<SaleRef>(
    'SELECT id, status, location_id, cashier_id FROM pos_sales WHERE id = $1 AND organization_id = $2 FOR UPDATE',
    [id, organizationId],
  );
  if (!rows[0]) throw notFound('Sale');
  return rows[0];
}

/** Ends a pending sale: frees held stock, fails pending payments, voids confirmed ones (any cash taken goes back to the customer). */
async function abandonSale(tx: Tx, saleId: string): Promise<void> {
  await releaseReferenceReservations(tx, 'pos_sale', saleId);
  await tx.query(
    `UPDATE pos_payments SET status = CASE status WHEN 'pending' THEN 'failed' ELSE 'voided' END
      WHERE sale_id = $1 AND status IN ('pending', 'confirmed')`,
    [saleId],
  );
  await tx.query(`UPDATE pos_sales SET status = 'cancelled' WHERE id = $1`, [saleId]);
}

export const posSaleRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/pos/registers/:id/price', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = z.object({ variantId: uuid }).parse(req.query);
    const r = await db.query<{ location_id: string; price_list_id: string }>('SELECT location_id, price_list_id FROM pos_registers WHERE id = $1 AND organization_id = $2', [id, req.actor.organizationId]);
    if (!r.rows[0]) throw notFound('Register');
    await authorize(db, req.actor, 'pos.sell', { kind: 'location', locationId: r.rows[0].location_id });
    const { rows } = await db.query<{ unitPrice: string; rate: string | null }>(
      `SELECT i.unit_price AS "unitPrice", t.code AS "taxCode", t.rate, t.price_inclusive AS "taxInclusive"
         FROM price_list_items i LEFT JOIN tax_codes t ON t.id = i.tax_code_id
        WHERE i.price_list_id = $1 AND i.variant_id = $2 AND i.effective_from <= now() AND (i.effective_to IS NULL OR i.effective_to > now())`,
      [r.rows[0].price_list_id, q.variantId],
    );
    if (!rows[0]) throw notFound('Price');
    return { ...rows[0], unitPrice: normalize(rows[0].unitPrice), rate: rows[0].rate === null ? null : normalize(rows[0].rate) };
  });


  // Prices a cart exactly as a sale would, without creating anything. Terminals show these numbers; they do not
  // compute money themselves.
  app.post('/pos/registers/:id/quote', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ lines: saleBody.shape.lines }).parse(req.body);
    const { actor } = req;
    const reg = await db.query<{ location_id: string; price_list_id: string; max_discount_bps: number; currency: string; minor_unit: number }>(
      `SELECT r.location_id, r.price_list_id, r.max_discount_bps, pl.currency, c.minor_unit FROM pos_registers r
         JOIN price_lists pl ON pl.id = r.price_list_id JOIN currencies c ON c.code = pl.currency WHERE r.id = $1 AND r.organization_id = $2`,
      [id, actor.organizationId],
    );
    const register = reg.rows[0];
    if (!register) throw notFound('Register');
    const target = { kind: 'location', locationId: register.location_id } as const;
    await authorize(db, actor, 'pos.sell', target);
    if (body.lines.some((l) => l.discount) && !(await can(db, actor, 'pos.discount', target))) throw forbidden('You are not permitted to give discounts');
    const mayOverride = await can(db, actor, 'pos.discount.override', target);

    const priced = await priceSaleLines(db as unknown as Tx, { organizationId: actor.organizationId, priceListId: register.price_list_id, minorUnit: register.minor_unit, maxDiscountBps: register.max_discount_bps, mayOverride, now: new Date() }, body.lines as SaleLineInput[]);
    const t = saleTotals(priced);
    const lines = [];
    for (const l of priced) {
      const free = await db.query<{ free: string }>(
        `SELECT COALESCE(sum(quantity - reserved), 0) AS free FROM stock_balances
          WHERE location_id = $1 AND variant_id = $2 AND state = 'on_hand' AND lot_key = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
        [register.location_id, l.variantId, l.lotId],
      );
      lines.push({
        variantId: l.variantId, sku: l.sku, lotId: l.lotId, quantity: l.quantity, unitPrice: l.unitPrice,
        taxCode: l.tax?.code ?? null, taxRate: l.tax?.rate ?? '0', taxInclusive: l.tax?.inclusive ?? false, discountBps: l.p.discountBps,
        grossMinor: Number(l.p.gross), discountMinor: Number(l.p.discount), taxMinor: Number(l.p.tax), totalMinor: Number(l.p.total),
        available: normalize(free.rows[0]!.free), insufficientStock: toScaled(free.rows[0]!.free) < toScaled(l.quantity),
      });
    }
    return {
      currency: register.currency.trim(), minorUnit: register.minor_unit, lines,
      subtotalMinor: Number(t.subtotal), discountMinor: Number(t.discount), taxMinor: Number(t.tax), totalMinor: Number(t.total),
      sellable: t.total > 0n && lines.every((l) => !l.insufficientStock),
    };
  });

  app.post('/pos/sales', async (req, reply) => {
    const body = saleBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const reg = await tx.query<{
        id: string; legal_entity_id: string; location_id: string; code: string; status: string; price_list_id: string;
        max_discount_bps: number; next_receipt_no: string; currency: string; minor_unit: number;
      }>(
        `SELECT r.id, r.legal_entity_id, r.location_id, r.code, r.status, r.price_list_id, r.max_discount_bps, r.next_receipt_no,
                pl.currency, c.minor_unit
           FROM pos_registers r JOIN price_lists pl ON pl.id = r.price_list_id JOIN currencies c ON c.code = pl.currency
          WHERE r.id = $1 AND r.organization_id = $2 FOR UPDATE OF r`,
        [body.registerId, actor.organizationId],
      );
      const register = reg.rows[0];
      if (!register) throw notFound('Register');
      const target = { kind: 'location', locationId: register.location_id } as const;
      await authorize(tx, actor, 'pos.sell', target);
      if (register.status !== 'active') throw conflict('Register is inactive');

      const session = await tx.query<{ id: string; cashier_id: string }>(`SELECT id, cashier_id FROM pos_sessions WHERE register_id = $1 AND status = 'open'`, [register.id]);
      if (!session.rows[0]) throw conflict('Open a session on this register before selling');
      if (session.rows[0].cashier_id !== actor.userId) throw forbidden('This register session belongs to another cashier');

      const mayDiscount = body.lines.some((l) => l.discount) ? await can(tx, actor, 'pos.discount', target) : true;
      if (!mayDiscount) throw forbidden('You are not permitted to give discounts');
      const mayOverride = await can(tx, actor, 'pos.discount.override', target);

      const now = new Date();
      const priced = await priceSaleLines(tx, { organizationId: actor.organizationId, priceListId: register.price_list_id, minorUnit: register.minor_unit, maxDiscountBps: register.max_discount_bps, mayOverride, now }, body.lines as SaleLineInput[]);
      const { subtotal, discount, tax: taxTotal, total } = saleTotals(priced);
      if (total <= 0n) throw invalid('Sale total must be greater than zero');
      if (body.expectedTotalMinor !== undefined && BigInt(body.expectedTotalMinor) !== total) {
        throw conflict(`Total is now ${total}, not ${body.expectedTotalMinor}; prices changed`);
      }

      const paid = body.payments.reduce((a, p) => a + BigInt(p.amountMinor), 0n);
      if (paid !== total) throw invalid(`Payments total ${paid} but the sale total is ${total}`);
      for (const p of body.payments) {
        if (p.method === 'cash') {
          if (p.tenderedMinor !== undefined && p.tenderedMinor < p.amountMinor) throw invalid('Cash tendered is less than the amount applied');
        } else {
          if (!p.reference) throw invalid(`${p.method} payments need a provider reference`);
          if (p.tenderedMinor !== undefined) throw invalid('Only cash has a tendered amount');
        }
      }
      const allCash = body.payments.every((p) => p.method === 'cash');

      const receiptNumber = `${register.code}-${register.next_receipt_no.padStart(6, '0')}`;
      await tx.query('UPDATE pos_registers SET next_receipt_no = next_receipt_no + 1 WHERE id = $1', [register.id]);
      const sale = await tx.query<{ id: string }>(
        `INSERT INTO pos_sales (organization_id, legal_entity_id, location_id, register_id, session_id, receipt_number, status, currency, minor_unit,
                                price_list_id, subtotal_minor, discount_minor, tax_minor, total_minor, cashier_id, note, device_id, client_timestamp, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [
          actor.organizationId, register.legal_entity_id, register.location_id, register.id, session.rows[0].id, receiptNumber,
          allCash ? 'completed' : 'pending_payment', register.currency, register.minor_unit, register.price_list_id,
          subtotal, discount, taxTotal, total, actor.userId, body.note ?? null, body.deviceId ?? null, body.clientTimestamp ?? null,
          allCash ? now : null,
        ],
      );
      const saleId = sale.rows[0]!.id;

      for (const [i, l] of priced.entries()) {
        await tx.query(
          `INSERT INTO pos_sale_lines (sale_id, line_no, variant_id, lot_id, quantity, unit_price, price_list_item_id, tax_code, tax_rate,
                                       tax_inclusive, discount_bps, gross_minor, discount_minor, tax_minor, total_minor)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [saleId, i + 1, l.variantId, l.lotId, l.quantity, l.unitPrice, l.itemId, l.tax?.code ?? null, l.tax?.rate ?? '0',
           l.tax?.inclusive ?? false, l.p.discountBps, l.p.gross, l.p.discount, l.p.tax, l.p.total],
        );
      }

      if (allCash) {
        const postings: Posting[] = priced.map((l) => ({ locationId: register.location_id, variantId: l.variantId, lotId: l.lotId, state: 'on_hand', delta: `-${l.quantity}`, type: 'issue' }));
        await postMovements(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id, reason: 'sale', referenceType: 'pos_sale', referenceId: saleId }, postings);
      } else {
        // Stock is held, not issued, until every payment is verified.
        for (const l of priced) {
          await createReservation(tx, { organizationId: actor.organizationId, userId: actor.userId, locationId: register.location_id, variantId: l.variantId, lotId: l.lotId, quantity: l.quantity, referenceType: 'pos_sale', referenceId: saleId });
        }
      }

      for (const p of body.payments) {
        const cash = p.method === 'cash';
        const tendered = cash ? (p.tenderedMinor ?? p.amountMinor) : null;
        await tx.query(
          `INSERT INTO pos_payments (organization_id, sale_id, method, amount_minor, tendered_minor, change_minor, reference, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [actor.organizationId, saleId, p.method, p.amountMinor, tendered, cash ? tendered! - p.amountMinor : null, p.reference ?? null, cash ? 'confirmed' : 'pending', actor.userId],
        );
      }
      await audit(tx, req, 'pos.sale', 'pos_sale', saleId, { receiptNumber, total: Number(total), status: allCash ? 'completed' : 'pending_payment' });
      return { status: 201, body: await readSale(tx, actor.organizationId, saleId) };
    });
  });

  app.get('/pos/sales/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const sale = await readSale(db, req.actor.organizationId, id);
    await authorize(db, req.actor, 'pos.read', { kind: 'location', locationId: sale.locationId });
    return sale;
  });

  app.get('/pos/sales', async (req) => {
    const q = z.object({ registerId: uuid.optional(), sessionId: uuid.optional(), receipt: z.string().trim().min(1).max(60).optional(), status: z.enum(['pending_payment', 'completed', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const grants = await grantsFor(db, req.actor, 'pos.read');
    const scope = scopeFilter(grants, 7);
    const { rows } = await db.query(
      `SELECT s.id, s.receipt_number AS "receiptNumber", s.status, s.total_minor::float8 AS "totalMinor", s.currency, s.created_at AS "createdAt"
         FROM pos_sales s JOIN locations l ON l.id = s.location_id
        WHERE s.organization_id = $1 AND ($2::uuid IS NULL OR s.register_id = $2) AND ($3::uuid IS NULL OR s.session_id = $3)
          AND ($4::text IS NULL OR s.status = $4) AND ($6::text IS NULL OR s.receipt_number = $6) AND ${scope.clause}
        ORDER BY s.created_at DESC LIMIT $5`,
      [req.actor.organizationId, q.registerId ?? null, q.sessionId ?? null, q.status ?? null, q.limit, q.receipt ?? null, ...scope.params],
    );
    return rows;
  });

  // Stands in for a payment-provider confirmation until provider adapters exist. A different person than the cashier must confirm.
  app.post('/pos/payments/:id/verify', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const ref = await tx.query<{ sale_id: string }>('SELECT sale_id FROM pos_payments WHERE id = $1 AND organization_id = $2', [id, actor.organizationId]);
      if (!ref.rows[0]) throw notFound('Payment');
      const sale = await lockSale(tx, actor.organizationId, ref.rows[0].sale_id);
      await authorize(tx, actor, 'pos.payment.verify', { kind: 'location', locationId: sale.location_id });
      const pay = await tx.query<{ status: string; created_by: string }>('SELECT status, created_by FROM pos_payments WHERE id = $1 FOR UPDATE', [id]);
      const p = pay.rows[0]!;
      if (sale.status !== 'pending_payment' || p.status !== 'pending') throw conflict('Payment is not awaiting verification');
      if (p.created_by === actor.userId) throw forbidden('You cannot verify a payment you recorded');

      await tx.query(`UPDATE pos_payments SET status = 'confirmed', verified_by = $2, verified_at = now() WHERE id = $1`, [id, actor.userId]);
      const left = await tx.query(`SELECT 1 FROM pos_payments WHERE sale_id = $1 AND status = 'pending'`, [sale.id]);
      if (!left.rowCount) {
        await fulfilReferenceReservations(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id }, 'pos_sale', sale.id, 'sale');
        await tx.query(`UPDATE pos_sales SET status = 'completed', completed_at = now() WHERE id = $1`, [sale.id]);
      }
      await audit(tx, req, 'pos.payment_verify', 'pos_payment', id, { saleId: sale.id });
      return { status: 200, body: await readSale(tx, actor.organizationId, sale.id) };
    });
  });

  app.post('/pos/payments/:id/fail', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const ref = await tx.query<{ sale_id: string }>('SELECT sale_id FROM pos_payments WHERE id = $1 AND organization_id = $2', [id, actor.organizationId]);
      if (!ref.rows[0]) throw notFound('Payment');
      const sale = await lockSale(tx, actor.organizationId, ref.rows[0].sale_id);
      await authorize(tx, actor, 'pos.payment.verify', { kind: 'location', locationId: sale.location_id });
      const pay = await tx.query<{ status: string }>('SELECT status FROM pos_payments WHERE id = $1 FOR UPDATE', [id]);
      if (sale.status !== 'pending_payment' || pay.rows[0]!.status !== 'pending') throw conflict('Payment is not awaiting verification');
      await abandonSale(tx, sale.id);
      await audit(tx, req, 'pos.payment_fail', 'pos_payment', id, { saleId: sale.id });
      return { status: 200, body: await readSale(tx, actor.organizationId, sale.id) };
    });
  });

  app.post('/pos/sales/:id/cancel', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const sale = await lockSale(tx, actor.organizationId, id);
      await authorize(tx, actor, 'pos.sell', { kind: 'location', locationId: sale.location_id });
      if (sale.status !== 'pending_payment') throw conflict('Only sales awaiting payment can be cancelled; use a return for completed sales');
      await abandonSale(tx, sale.id);
      await audit(tx, req, 'pos.sale_cancel', 'pos_sale', id);
      return { status: 200, body: await readSale(tx, actor.organizationId, id) };
    });
  });
};
