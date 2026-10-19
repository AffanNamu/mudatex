import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, can, grantsFor } from '../auth/authorize.js';
import type { Db, Tx } from '../db.js';
import { fromScaled, normalize, toScaled } from '../domain/decimal.js';
import { refundShare } from '../domain/money.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { audit, loadVariant, quantityField, resolveQuantity, scopeFilter, uuid } from '../inventory/common.js';
import { postMovements, type Posting } from '../inventory/ledger.js';

const returnBody = z.object({
  reason: z.string().trim().min(5).max(1000),
  refund: z.object({ method: z.enum(['cash', 'card', 'bank_transfer', 'mobile_money']) }),
  lines: z
    .array(z.object({ saleLineId: uuid, quantity: quantityField, unitId: uuid.optional(), restock: z.boolean() }))
    .min(1)
    .max(100),
});

async function readReturn(db: Db | Tx, organizationId: string, id: string) {
  const r = await db.query(
    `SELECT id, sale_id AS "saleId", return_number AS "returnNumber", reason, refund_method AS "refundMethod",
            refund_reference AS "refundReference", refund_total_minor AS "refundTotalMinor", refund_status AS "refundStatus",
            processed_by AS "processedBy", created_at AS "createdAt"
       FROM pos_returns WHERE id = $1 AND organization_id = $2`,
    [id, organizationId],
  );
  if (!r.rows[0]) throw notFound('Return');
  const lines = await db.query(
    `SELECT sale_line_id AS "saleLineId", quantity, restock, refund_minor AS "refundMinor", tax_refund_minor AS "taxRefundMinor"
       FROM pos_return_lines WHERE return_id = $1 ORDER BY seq`,
    [id],
  );
  return {
    ...r.rows[0],
    refundTotalMinor: Number(r.rows[0].refundTotalMinor),
    lines: lines.rows.map((l) => ({ ...l, quantity: normalize(l.quantity), refundMinor: Number(l.refundMinor), taxRefundMinor: Number(l.taxRefundMinor) })),
  };
}

export const posReturnRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/pos/sales/:id/returns', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = returnBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const s = await tx.query<{ id: string; status: string; location_id: string; register_id: string }>(
        'SELECT id, status, location_id, register_id FROM pos_sales WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [id, actor.organizationId],
      );
      const sale = s.rows[0];
      if (!sale) throw notFound('Sale');
      const target = { kind: 'location', locationId: sale.location_id } as const;
      await authorize(tx, actor, 'pos.refund', target);
      if (sale.status !== 'completed') throw conflict('Only completed sales can be returned');

      const reg = await tx.query<{ code: string; refund_threshold_minor: string | null; next_return_no: string }>(
        'SELECT code, refund_threshold_minor, next_return_no FROM pos_registers WHERE id = $1 FOR UPDATE',
        [sale.register_id],
      );
      const register = reg.rows[0]!;
      const session = await tx.query<{ id: string }>(`SELECT id FROM pos_sessions WHERE register_id = $1 AND status = 'open'`, [sale.register_id]);
      if (!session.rows[0]) throw conflict('Open a session on the sale\'s register to process returns');

      const methods = await tx.query<{ method: string }>(`SELECT DISTINCT method FROM pos_payments WHERE sale_id = $1 AND status = 'confirmed'`, [id]);
      if (!methods.rows.some((m) => m.method === body.refund.method)) throw invalid('Refunds must use a payment method the customer originally paid with');

      const lines: { saleLineId: string; quantity: string; restock: boolean; refund: bigint; taxRefund: bigint; variantId: string; lotId: string | null }[] = [];
      for (const input of body.lines) {
        const l = await tx.query<{ variant_id: string; lot_id: string | null; quantity: string; returned_quantity: string; total_minor: string; tax_minor: string }>(
          `SELECT variant_id, lot_id, quantity, returned_quantity, total_minor, tax_minor FROM pos_sale_lines WHERE id = $1 AND sale_id = $2 FOR UPDATE`,
          [input.saleLineId, id],
        );
        const line = l.rows[0];
        if (!line) throw notFound('Sale line');
        const variant = await loadVariant(tx, actor.organizationId, line.variant_id);
        const quantity = await resolveQuantity(tx, variant, input.quantity, input.unitId);
        const before = normalize(line.returned_quantity);
        const after = fromScaled(toScaled(before) + toScaled(quantity));
        if (toScaled(after) > toScaled(line.quantity)) throw conflict('Return quantity exceeds what was sold and not yet returned');

        const refund = refundShare(BigInt(line.total_minor), line.quantity, before, after);
        const taxRefund = refundShare(BigInt(line.tax_minor), line.quantity, before, after);
        await tx.query('UPDATE pos_sale_lines SET returned_quantity = $2 WHERE id = $1', [input.saleLineId, after]);
        lines.push({ saleLineId: input.saleLineId, quantity, restock: input.restock, refund, taxRefund, variantId: line.variant_id, lotId: line.lot_id });
      }

      const total = lines.reduce((a, l) => a + l.refund, 0n);
      const limit = register.refund_threshold_minor;
      if (limit !== null && total > BigInt(limit) && !(await can(tx, actor, 'pos.refund.approve', target))) {
        throw forbidden('This refund is above the register limit and needs a supervisor with refund approval');
      }

      const returnNumber = `R-${register.code}-${register.next_return_no.padStart(6, '0')}`;
      await tx.query('UPDATE pos_registers SET next_return_no = next_return_no + 1 WHERE id = $1', [sale.register_id]);
      const cash = body.refund.method === 'cash';
      const ret = await tx.query<{ id: string }>(
        `INSERT INTO pos_returns (organization_id, sale_id, session_id, return_number, reason, refund_method, refund_total_minor, refund_status, processed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [actor.organizationId, id, session.rows[0].id, returnNumber, body.reason, body.refund.method, total, cash ? 'recorded' : 'pending_disbursement', actor.userId],
      );
      const returnId = ret.rows[0]!.id;
      for (const l of lines) {
        await tx.query(
          'INSERT INTO pos_return_lines (return_id, sale_line_id, quantity, restock, refund_minor, tax_refund_minor) VALUES ($1,$2,$3,$4,$5,$6)',
          [returnId, l.saleLineId, l.quantity, l.restock, l.refund, l.taxRefund],
        );
      }
      const postings: Posting[] = lines.filter((l) => l.restock).map((l) => ({ locationId: sale.location_id, variantId: l.variantId, lotId: l.lotId, state: 'on_hand', delta: l.quantity, type: 'sale_return' }));
      if (postings.length) {
        await postMovements(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id, reason: body.reason, referenceType: 'pos_return', referenceId: returnId }, postings);
      }
      await audit(tx, req, 'pos.return', 'pos_return', returnId, { returnNumber, saleId: id, refundTotalMinor: Number(total), method: body.refund.method });
      return { status: 201, body: await readReturn(tx, actor.organizationId, returnId) };
    });
  });

  app.get('/pos/returns', async (req) => {
    const q = z.object({ status: z.enum(['recorded', 'pending_disbursement', 'disbursed']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const grants = await grantsFor(db, req.actor, 'pos.read');
    const scope = scopeFilter(grants, 4);
    const { rows } = await db.query(
      `SELECT r.id, r.return_number AS "returnNumber", s.receipt_number AS "receiptNumber", r.refund_method AS "refundMethod",
              r.refund_total_minor::float8 AS "refundTotalMinor", r.refund_status AS "refundStatus", s.currency, s.minor_unit AS "minorUnit", r.created_at AS "createdAt"
         FROM pos_returns r JOIN pos_sales s ON s.id = r.sale_id JOIN locations l ON l.id = s.location_id
        WHERE r.organization_id = $1 AND ($2::text IS NULL OR r.refund_status = $2) AND ${scope.clause}
        ORDER BY r.created_at DESC, r.return_number DESC LIMIT $3`,
      [req.actor.organizationId, q.status ?? null, q.limit, ...scope.params],
    );
    return rows;
  });

  app.get('/pos/returns/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ret = await readReturn(db, req.actor.organizationId, id);
    const sale = await db.query<{ location_id: string }>('SELECT location_id FROM pos_sales WHERE id = $1', [ret.saleId]);
    await authorize(db, req.actor, 'pos.read', { kind: 'location', locationId: sale.rows[0]!.location_id });
    return ret;
  });

  // Records that a non-cash refund was actually paid out. A second person must do it.
  app.post('/pos/returns/:id/disburse', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ reference: z.string().min(1).max(200) }).parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const r = await tx.query<{ refund_status: string; processed_by: string; location_id: string }>(
        `SELECT r.refund_status, r.processed_by, s.location_id FROM pos_returns r JOIN pos_sales s ON s.id = r.sale_id
          WHERE r.id = $1 AND r.organization_id = $2 FOR UPDATE OF r`,
        [id, actor.organizationId],
      );
      const row = r.rows[0];
      if (!row) throw notFound('Return');
      await authorize(tx, actor, 'pos.payment.verify', { kind: 'location', locationId: row.location_id });
      if (row.refund_status !== 'pending_disbursement') throw conflict('Refund is not awaiting disbursement');
      if (row.processed_by === actor.userId) throw forbidden('You cannot disburse a refund you processed');
      await tx.query(`UPDATE pos_returns SET refund_status = 'disbursed', disbursed_by = $2, refund_reference = $3 WHERE id = $1`, [id, actor.userId, body.reference]);
      await audit(tx, req, 'pos.refund_disburse', 'pos_return', id, { reference: body.reference });
      return { status: 200, body: await readReturn(tx, actor.organizationId, id) };
    });
  });
};
