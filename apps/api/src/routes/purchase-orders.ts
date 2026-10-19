import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, grantsFor } from '../auth/authorize.js';
import { withTx, type Db, type Tx } from '../db.js';
import { nextDocumentNumber } from '../documents.js';
import { fromScaled, normalize, toScaled } from '../domain/decimal.js';
import { grossMinor } from '../domain/money.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { audit, checkLot, loadStockLocation, loadVariant, quantityField, resolveQuantity, scopeFilter, uuid } from '../inventory/common.js';
import { postMovements, type Posting } from '../inventory/ledger.js';
import { resolveReceiptLot } from '../inventory/service.js';

const price = z.string().regex(/^\d+(\.\d{1,4})?$/);

const orderLines = z
  .array(z.object({ variantId: uuid, quantity: quantityField, unitId: uuid.optional(), unitPrice: price }))
  .min(1)
  .max(200);

const createBody = z.object({
  supplierId: uuid,
  destinationLocationId: uuid,
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  overReceiptToleranceBps: z.number().int().min(0).max(5000).default(0),
  note: z.string().max(1000).optional(),
  lines: orderLines,
});

const updateBody = z.object({
  expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  overReceiptToleranceBps: z.number().int().min(0).max(5000).optional(),
  note: z.string().max(1000).nullable().optional(),
  lines: orderLines.optional(),
});

const receiptBody = z.object({
  deliveryNote: z.string().max(200).optional(),
  lines: z
    .array(
      z.object({
        poLineId: uuid,
        quantity: quantityField.optional(),
        unitId: uuid.optional(),
        lotCode: z.string().min(1).max(100).optional(),
        rejectedQuantity: quantityField.optional(),
        rejectReason: z.string().trim().min(3).max(500).optional(),
      }),
    )
    .min(1)
    .max(200),
});

const returnBody = z.object({
  reason: z.string().trim().min(5).max(1000),
  lines: z.array(z.object({ poLineId: uuid, lotId: uuid.optional(), quantity: quantityField, unitId: uuid.optional() })).min(1).max(200),
});

interface PoRow {
  id: string;
  legal_entity_id: string;
  supplier_id: string;
  destination_location_id: string;
  status: string;
  currency: string;
  minor_unit: number;
  created_by: string;
  over_receipt_tolerance_bps: number;
}

async function lockPo(tx: Tx, organizationId: string, id: string): Promise<PoRow> {
  const { rows } = await tx.query<PoRow>(
    `SELECT id, legal_entity_id, supplier_id, destination_location_id, status, currency, minor_unit, created_by, over_receipt_tolerance_bps
       FROM purchase_orders WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [id, organizationId],
  );
  if (!rows[0]) throw notFound('Purchase order');
  return rows[0];
}

async function readPo(db: Db | Tx, organizationId: string, id: string) {
  const o = await db.query(
    `SELECT o.id, o.po_number AS "poNumber", o.status, o.supplier_id AS "supplierId", s.code AS "supplierCode", s.name AS "supplierName",
            o.legal_entity_id AS "legalEntityId", o.destination_location_id AS "destinationLocationId", l.name AS "destinationName",
            o.currency, o.minor_unit AS "minorUnit", o.total_minor AS "totalMinor",
            o.over_receipt_tolerance_bps AS "overReceiptToleranceBps", o.expected_date::text AS "expectedDate", o.note,
            o.created_by AS "createdBy", o.decided_by AS "decidedBy", o.decision_note AS "decisionNote",
            o.created_at AS "createdAt", o.submitted_at AS "submittedAt", o.decided_at AS "decidedAt"
       FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id JOIN locations l ON l.id = o.destination_location_id
      WHERE o.id = $1 AND o.organization_id = $2`,
    [id, organizationId],
  );
  if (!o.rows[0]) throw notFound('Purchase order');
  const lines = await db.query(
    `SELECT pl.id, pl.line_no AS "lineNo", pl.variant_id AS "variantId", v.sku, p.name AS "productName", v.tracking,
            pl.quantity, pl.unit_price AS "unitPrice", pl.total_minor AS "totalMinor",
            pl.received_quantity AS "receivedQuantity", pl.returned_quantity AS "returnedQuantity"
       FROM purchase_order_lines pl JOIN product_variants v ON v.id = pl.variant_id JOIN products p ON p.id = v.product_id
      WHERE pl.purchase_order_id = $1 ORDER BY pl.line_no`,
    [id],
  );
  const receipts = await db.query(
    `SELECT id, receipt_number AS "receiptNumber", delivery_note AS "deliveryNote", created_at AS "createdAt"
       FROM goods_receipts WHERE purchase_order_id = $1 ORDER BY receipt_number`,
    [id],
  );
  return {
    ...o.rows[0],
    totalMinor: Number(o.rows[0].totalMinor),
    lines: lines.rows.map((l) => ({
      ...l,
      quantity: normalize(l.quantity),
      unitPrice: normalize(l.unitPrice),
      totalMinor: Number(l.totalMinor),
      receivedQuantity: normalize(l.receivedQuantity),
      returnedQuantity: normalize(l.returnedQuantity),
      outstandingQuantity: fromScaled(max0(toScaled(l.quantity) - toScaled(l.receivedQuantity))),
    })),
    receipts: receipts.rows,
  };
}

const max0 = (n: bigint) => (n < 0n ? 0n : n);

async function writeLines(tx: Tx, organizationId: string, po: PoRow, lines: z.infer<typeof orderLines>) {
  await tx.query('DELETE FROM purchase_order_lines WHERE purchase_order_id = $1', [po.id]);
  let total = 0n;
  for (const [i, l] of lines.entries()) {
    const variant = await loadVariant(tx, organizationId, l.variantId);
    const qty = await resolveQuantity(tx, variant, l.quantity, l.unitId);
    const lineTotal = grossMinor(qty, l.unitPrice, po.minor_unit);
    total += lineTotal;
    await tx.query(
      'INSERT INTO purchase_order_lines (purchase_order_id, line_no, variant_id, quantity, unit_price, total_minor) VALUES ($1,$2,$3,$4,$5,$6)',
      [po.id, i + 1, variant.id, qty, l.unitPrice, lineTotal],
    );
  }
  await tx.query('UPDATE purchase_orders SET total_minor = $2 WHERE id = $1', [po.id, total]);
}

export const purchaseOrderRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/procurement/purchase-orders', async (req, reply) => {
    const body = createBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      await authorize(tx, actor, 'procurement.create', { kind: 'location', locationId: body.destinationLocationId });
      const location = await loadStockLocation(tx, actor.organizationId, body.destinationLocationId);
      const supplier = await tx.query<{ status: string; default_currency: string }>('SELECT status, default_currency FROM suppliers WHERE id = $1 AND organization_id = $2', [body.supplierId, actor.organizationId]);
      if (!supplier.rows[0]) throw notFound('Supplier');
      if (supplier.rows[0].status !== 'active') throw conflict('Supplier is blocked');
      const currency = body.currency ?? supplier.rows[0].default_currency.trim();
      const cur = await tx.query<{ minor_unit: number }>('SELECT minor_unit FROM currencies WHERE code = $1', [currency]);
      if (!cur.rows[0]) throw invalid(`Unknown currency ${currency}`);

      const number = await nextDocumentNumber(tx, actor.organizationId, location.legalEntityId, 'PO', 'PO');
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO purchase_orders (organization_id, legal_entity_id, supplier_id, destination_location_id, po_number, currency, minor_unit,
                                      over_receipt_tolerance_bps, expected_date, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [actor.organizationId, location.legalEntityId, body.supplierId, location.id, number, currency, cur.rows[0].minor_unit,
         body.overReceiptToleranceBps, body.expectedDate ?? null, body.note ?? null, actor.userId],
      );
      const po = await lockPo(tx, actor.organizationId, ins.rows[0]!.id);
      await writeLines(tx, actor.organizationId, po, body.lines);
      await audit(tx, req, 'po.create', 'purchase_order', po.id, { poNumber: number });
      return { status: 201, body: await readPo(tx, actor.organizationId, po.id) };
    });
  });

  // Drafts can be edited freely; once submitted the order is frozen for approval.
  app.put('/procurement/purchase-orders/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = updateBody.parse(req.body);
    const { actor } = req;
    return withTx(db, async (tx) => {
      const po = await lockPo(tx, actor.organizationId, id);
      await authorize(tx, actor, 'procurement.create', { kind: 'location', locationId: po.destination_location_id });
      if (po.status !== 'draft') throw conflict('Only draft orders can be edited');
      if (body.lines) await writeLines(tx, actor.organizationId, po, body.lines);
      await tx.query(
        `UPDATE purchase_orders SET expected_date = CASE WHEN $2 THEN $3::date ELSE expected_date END,
                over_receipt_tolerance_bps = COALESCE($4, over_receipt_tolerance_bps),
                note = CASE WHEN $5 THEN $6 ELSE note END WHERE id = $1`,
        [id, body.expectedDate !== undefined, body.expectedDate ?? null, body.overReceiptToleranceBps ?? null, body.note !== undefined, body.note ?? null],
      );
      await audit(tx, req, 'po.update', 'purchase_order', id);
      return readPo(tx, actor.organizationId, id);
    });
  });

  app.get('/procurement/purchase-orders/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const po = await readPo(db, req.actor.organizationId, id);
    await authorize(db, req.actor, 'procurement.read', { kind: 'location', locationId: po.destinationLocationId });
    return po;
  });

  app.get('/procurement/purchase-orders', async (req) => {
    const q = z
      .object({ status: z.string().optional(), supplierId: uuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    const grants = await grantsFor(db, req.actor, 'procurement.read');
    const scope = scopeFilter(grants, 5);
    const { rows } = await db.query(
      `SELECT p.id, p.po_number AS "poNumber", p.status, p.supplier_id AS "supplierId", s.name AS "supplierName", p.currency, p.minor_unit AS "minorUnit",
              p.total_minor::float8 AS "totalMinor", p.destination_location_id AS "destinationLocationId", l.name AS "destinationName", p.created_at AS "createdAt"
         FROM purchase_orders p JOIN locations l ON l.id = p.destination_location_id JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.organization_id = $1 AND ($2::text IS NULL OR p.status = $2) AND ($3::uuid IS NULL OR p.supplier_id = $3) AND ${scope.clause}
        ORDER BY p.created_at DESC, p.id LIMIT $4`,
      [req.actor.organizationId, q.status ?? null, q.supplierId ?? null, q.limit, ...scope.params],
    );
    return rows;
  });

  const transition = (name: string, perm: 'procurement.create' | 'procurement.approve', from: string[], to: string, extra?: (tx: Tx, po: PoRow, actorId: string, body: { note?: string }) => Promise<void>, needNote = false) =>
    app.post(`/procurement/purchase-orders/:id/${name}`, async (req, reply) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const body = (needNote ? z.object({ note: z.string().trim().min(3).max(1000) }) : z.object({ note: z.string().trim().max(1000).optional() }).default({})).parse(req.body ?? {});
      const { actor } = req;
      return idempotent(db, req, reply, async (tx) => {
        const po = await lockPo(tx, actor.organizationId, id);
        await authorize(tx, actor, perm, { kind: 'location', locationId: po.destination_location_id });
        if (!from.includes(po.status)) throw conflict(`Order is ${po.status}`);
        if (extra) await extra(tx, po, actor.userId, body);
        await tx.query('UPDATE purchase_orders SET status = $2 WHERE id = $1', [id, to]);
        await audit(tx, req, `po.${name}`, 'purchase_order', id, { from: po.status, to, note: body.note });
        return { status: 200, body: await readPo(tx, actor.organizationId, id) };
      });
    });

  transition('submit', 'procurement.create', ['draft'], 'pending_approval', async (tx, po) => {
    const n = await tx.query('SELECT 1 FROM purchase_order_lines WHERE purchase_order_id = $1', [po.id]);
    if (!n.rowCount) throw invalid('An order needs at least one line');
    const s = await tx.query<{ status: string }>('SELECT status FROM suppliers WHERE id = $1', [po.supplier_id]);
    if (s.rows[0]!.status !== 'active') throw conflict('Supplier is blocked');
    await tx.query('UPDATE purchase_orders SET submitted_at = now() WHERE id = $1', [po.id]);
  });

  transition('approve', 'procurement.approve', ['pending_approval'], 'approved', async (tx, po, actorId, body) => {
    if (po.created_by === actorId) throw forbidden('You cannot approve an order you created');
    await tx.query('UPDATE purchase_orders SET decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1', [po.id, actorId, body.note ?? null]);
  });

  transition('reject', 'procurement.approve', ['pending_approval'], 'draft', async (tx, po, actorId, body) => {
    if (po.created_by === actorId) throw forbidden('You cannot decide an order you created');
    await tx.query('UPDATE purchase_orders SET decision_note = $2 WHERE id = $1', [po.id, body.note ?? null]);
  }, true);

  app.post('/procurement/purchase-orders/:id/cancel', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const po = await lockPo(tx, actor.organizationId, id);
      await authorize(tx, actor, 'procurement.create', { kind: 'location', locationId: po.destination_location_id });
      if (!['draft', 'pending_approval', 'approved'].includes(po.status)) throw conflict(`Order is ${po.status}; close it instead`);
      await tx.query(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1`, [id]);
      await audit(tx, req, 'po.cancel', 'purchase_order', id, { from: po.status });
      return { status: 200, body: await readPo(tx, actor.organizationId, id) };
    });
  });

  // Stops expecting the remainder of a partly received order.
  app.post('/procurement/purchase-orders/:id/close', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const po = await lockPo(tx, actor.organizationId, id);
      await authorize(tx, actor, 'procurement.approve', { kind: 'location', locationId: po.destination_location_id });
      if (po.status !== 'partially_received') throw conflict('Only partly received orders can be closed');
      await tx.query(`UPDATE purchase_orders SET status = 'closed' WHERE id = $1`, [id]);
      await audit(tx, req, 'po.close', 'purchase_order', id);
      return { status: 200, body: await readPo(tx, actor.organizationId, id) };
    });
  });

  app.post('/procurement/purchase-orders/:id/receipts', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = receiptBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      // Locking the order serializes receipts, so concurrent deliveries cannot over-receive.
      const po = await lockPo(tx, actor.organizationId, id);
      await authorize(tx, actor, 'procurement.receive', { kind: 'location', locationId: po.destination_location_id });
      if (!['approved', 'partially_received'].includes(po.status)) throw conflict(`Order is ${po.status}; goods can only be received against an approved order`);
      const location = await loadStockLocation(tx, actor.organizationId, po.destination_location_id);

      const number = await nextDocumentNumber(tx, actor.organizationId, po.legal_entity_id, 'GRN', 'GRN');
      const gr = await tx.query<{ id: string }>(
        'INSERT INTO goods_receipts (organization_id, purchase_order_id, receipt_number, delivery_note, received_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [actor.organizationId, id, number, body.deliveryNote ?? null, actor.userId],
      );
      const receiptId = gr.rows[0]!.id;

      const postings: Posting[] = [];
      for (const input of body.lines) {
        const l = await tx.query<{ variant_id: string; quantity: string; received_quantity: string }>(
          'SELECT variant_id, quantity, received_quantity FROM purchase_order_lines WHERE id = $1 AND purchase_order_id = $2 FOR UPDATE',
          [input.poLineId, id],
        );
        const line = l.rows[0];
        if (!line) throw notFound('Order line');
        const variant = await loadVariant(tx, actor.organizationId, line.variant_id);
        const accepted = input.quantity ? await resolveQuantity(tx, variant, input.quantity, input.unitId) : '0';
        const rejected = input.rejectedQuantity ? await resolveQuantity(tx, variant, input.rejectedQuantity, input.unitId) : '0';
        if (toScaled(accepted) === 0n && toScaled(rejected) === 0n) throw invalid('Each receipt line needs an accepted or rejected quantity');
        if (toScaled(rejected) > 0n && !input.rejectReason) throw invalid('A rejection reason is required');

        // Rejected goods are recorded but never stocked and do not count as received.
        const limit = (toScaled(line.quantity) * BigInt(10000 + po.over_receipt_tolerance_bps)) / 10000n;
        if (toScaled(line.received_quantity) + toScaled(accepted) > limit) throw conflict('Quantity exceeds what is outstanding on the order (plus tolerance)');

        let lotId: string | null = null;
        if (toScaled(accepted) > 0n) {
          lotId = await resolveReceiptLot(tx, actor.organizationId, variant, input.lotCode, accepted);
          postings.push({ locationId: location.id, variantId: variant.id, lotId, state: 'on_hand', delta: accepted, type: 'receipt' });
          await tx.query('UPDATE purchase_order_lines SET received_quantity = received_quantity + $2::numeric WHERE id = $1', [input.poLineId, accepted]);
        }
        await tx.query(
          'INSERT INTO goods_receipt_lines (goods_receipt_id, po_line_id, lot_id, quantity, rejected_quantity, reject_reason) VALUES ($1,$2,$3,$4,$5,$6)',
          [receiptId, input.poLineId, lotId, accepted, rejected, input.rejectReason ?? null],
        );
      }
      if (postings.length) {
        await postMovements(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id, referenceType: 'goods_receipt', referenceId: receiptId, reason: body.deliveryNote }, postings);
      }

      const open = await tx.query('SELECT 1 FROM purchase_order_lines WHERE purchase_order_id = $1 AND received_quantity < quantity', [id]);
      await tx.query('UPDATE purchase_orders SET status = $2 WHERE id = $1', [id, open.rowCount ? 'partially_received' : 'received']);
      await audit(tx, req, 'po.receive', 'goods_receipt', receiptId, { poId: id, receiptNumber: number });
      return { status: 201, body: await readPo(tx, actor.organizationId, id) };
    });
  });

  app.post('/procurement/purchase-orders/:id/returns', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = returnBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const po = await lockPo(tx, actor.organizationId, id);
      await authorize(tx, actor, 'procurement.return', { kind: 'location', locationId: po.destination_location_id });
      if (!['partially_received', 'received', 'closed'].includes(po.status)) throw conflict('Nothing has been received on this order');
      const location = await loadStockLocation(tx, actor.organizationId, po.destination_location_id);

      const number = await nextDocumentNumber(tx, actor.organizationId, po.legal_entity_id, 'RTS', 'RTS');
      const r = await tx.query<{ id: string }>(
        'INSERT INTO supplier_returns (organization_id, purchase_order_id, return_number, reason, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [actor.organizationId, id, number, body.reason, actor.userId],
      );
      const returnId = r.rows[0]!.id;

      const postings: Posting[] = [];
      for (const input of body.lines) {
        const l = await tx.query<{ variant_id: string; received_quantity: string; returned_quantity: string }>(
          'SELECT variant_id, received_quantity, returned_quantity FROM purchase_order_lines WHERE id = $1 AND purchase_order_id = $2 FOR UPDATE',
          [input.poLineId, id],
        );
        const line = l.rows[0];
        if (!line) throw notFound('Order line');
        const variant = await loadVariant(tx, actor.organizationId, line.variant_id);
        const lotId = await checkLot(tx, actor.organizationId, variant, input.lotId, { allowQuarantined: true });
        const qty = await resolveQuantity(tx, variant, input.quantity, input.unitId);
        if (toScaled(line.returned_quantity) + toScaled(qty) > toScaled(line.received_quantity)) throw conflict('Return quantity exceeds what was received and not yet returned');
        await tx.query('UPDATE purchase_order_lines SET returned_quantity = returned_quantity + $2::numeric WHERE id = $1', [input.poLineId, qty]);
        await tx.query('INSERT INTO supplier_return_lines (supplier_return_id, po_line_id, lot_id, quantity) VALUES ($1,$2,$3,$4)', [returnId, input.poLineId, lotId, qty]);
        postings.push({ locationId: location.id, variantId: variant.id, lotId, state: 'on_hand', delta: `-${qty}`, type: 'supplier_return' });
      }
      await postMovements(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id, referenceType: 'supplier_return', referenceId: returnId, reason: body.reason }, postings);
      await audit(tx, req, 'po.return', 'supplier_return', returnId, { poId: id, returnNumber: number });
      return { status: 201, body: { id: returnId, returnNumber: number, purchaseOrder: await readPo(tx, actor.organizationId, id) } };
    });
  });

  // Quantity still expected from open orders, for planning and availability promises.
  app.get('/procurement/on-order', async (req) => {
    const q = z.object({ variantId: uuid.optional(), locationId: uuid.optional() }).parse(req.query);
    const grants = await grantsFor(db, req.actor, 'procurement.read');
    const scope = scopeFilter(grants, 4);
    const { rows } = await db.query<{ onOrder: string }>(
      `SELECT p.destination_location_id AS "locationId", l2.variant_id AS "variantId",
              sum(GREATEST(l2.quantity - l2.received_quantity, 0)) AS "onOrder"
         FROM purchase_orders p JOIN purchase_order_lines l2 ON l2.purchase_order_id = p.id JOIN locations l ON l.id = p.destination_location_id
        WHERE p.organization_id = $1 AND p.status IN ('approved', 'partially_received')
          AND ($2::uuid IS NULL OR l2.variant_id = $2) AND ($3::uuid IS NULL OR p.destination_location_id = $3) AND ${scope.clause}
        GROUP BY 1, 2 HAVING sum(GREATEST(l2.quantity - l2.received_quantity, 0)) > 0 ORDER BY 1, 2`,
      [req.actor.organizationId, q.variantId ?? null, q.locationId ?? null, ...scope.params],
    );
    return rows.map((r) => ({ ...r, onOrder: normalize(r.onOrder) }));
  });
};
