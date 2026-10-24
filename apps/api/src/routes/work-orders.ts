import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, can, grantsFor } from '../auth/authorize.js';
import { withTx, type Db, type Tx } from '../db.js';
import { nextDocumentNumber } from '../documents.js';
import { fromScaled, normalize, toScaled } from '../domain/decimal.js';
import { requiredQuantity, withinTolerance } from '../domain/manufacturing.js';
import { roundDiv } from '../domain/money.js';
import { AppError, conflict, forbidden, invalid, notFound, shortage } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { audit, checkLot, loadStockLocation, loadVariant, quantityField, resolveQuantity, scopeFilter, uuid } from '../inventory/common.js';
import { postMovements, type Posting } from '../inventory/ledger.js';
import { consumeReservation, createReservation, releaseReferenceReservations, resolveReceiptLot } from '../inventory/service.js';
import { planAllocation, type Need } from '../manufacturing/availability.js';

const createBody = z.object({
  bomId: uuid,
  locationId: uuid,
  quantity: quantityField,
  unitId: uuid.optional(),
  plannedStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toleranceBps: z.number().int().min(0).max(10000).default(500),
  overProductionBps: z.number().int().min(0).max(5000).default(0),
  note: z.string().max(1000).optional(),
});

const moveLines = z
  .array(z.object({ componentId: uuid, lotId: uuid.optional(), quantity: quantityField, unitId: uuid.optional(), exceptionReason: z.string().trim().min(5).max(500).optional() }))
  .min(1)
  .max(100);

const outputBody = z.object({
  quantity: quantityField,
  unitId: uuid.optional(),
  lotCode: z.string().min(1).max(100).optional(),
  byproducts: z.array(z.object({ variantId: uuid, quantity: quantityField, unitId: uuid.optional(), lotCode: z.string().min(1).max(100).optional() })).max(20).default([]),
});

interface Wo {
  id: string;
  legal_entity_id: string;
  location_id: string;
  status: string;
  bom_id: string;
  output_variant_id: string;
  planned_quantity: string;
  produced_quantity: string;
  bom_output_quantity: string;
  expected_yield_bps: number;
  requires_qc: boolean;
  tolerance_bps: number;
  over_production_bps: number;
  created_by: string;
}

async function lockWo(tx: Tx, organizationId: string, id: string): Promise<Wo> {
  const { rows } = await tx.query<Wo>(
    `SELECT id, legal_entity_id, location_id, status, bom_id, output_variant_id, planned_quantity, produced_quantity, bom_output_quantity,
            expected_yield_bps, requires_qc, tolerance_bps, over_production_bps, created_by
       FROM work_orders WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [id, organizationId],
  );
  if (!rows[0]) throw notFound('Work order');
  return rows[0];
}

const ACTIVE = ['released', 'in_progress'];

export async function readWorkOrder(db: Db | Tx, organizationId: string, id: string) {
  const w = await db.query(
    `SELECT w.id, w.wo_number AS "woNumber", w.status, w.location_id AS "locationId", w.bom_id AS "bomId", w.output_variant_id AS "outputVariantId",
            v.sku AS "outputSku", p.name AS "outputProductName",
            w.planned_quantity AS "plannedQuantity", w.produced_quantity AS "producedQuantity", w.requires_qc AS "requiresQc",
            w.tolerance_bps AS "toleranceBps", w.over_production_bps AS "overProductionBps", w.planned_start::text AS "plannedStart", w.note,
            w.variance_reason AS "varianceReason", w.created_by AS "createdBy", w.released_by AS "releasedBy", w.created_at AS "createdAt"
       FROM work_orders w JOIN product_variants v ON v.id = w.output_variant_id JOIN products p ON p.id = v.product_id
      WHERE w.id = $1 AND w.organization_id = $2`,
    [id, organizationId],
  );
  if (!w.rows[0]) throw notFound('Work order');
  const comps = await db.query(
    `SELECT c.id, c.line_no AS "lineNo", c.variant_id AS "variantId", v.sku, p.name AS "productName", v.tracking, c.required_quantity AS "requiredQuantity",
            c.issued_quantity AS "issuedQuantity", c.returned_quantity AS "returnedQuantity",
            COALESCE((SELECT sum(a.quantity) FROM work_order_allocations a WHERE a.component_id = c.id), 0) AS "allocatedQuantity"
       FROM work_order_components c JOIN product_variants v ON v.id = c.variant_id JOIN products p ON p.id = v.product_id
      WHERE c.work_order_id = $1 ORDER BY c.line_no`,
    [id],
  );
  const allocs = await db.query(
    `SELECT a.component_id AS "componentId", a.lot_id AS "lotId", sl.code AS "lotCode", a.quantity, a.issued_quantity AS "issuedQuantity"
       FROM work_order_allocations a LEFT JOIN stock_lots sl ON sl.id = a.lot_id WHERE a.work_order_id = $1 ORDER BY sl.code NULLS FIRST, a.id`,
    [id],
  );
  const ops = await db.query(
    `SELECT o.op_no AS "opNo", o.name, o.work_centre_id AS "workCentreId", w.name AS "workCentreName", o.planned_minutes AS "plannedMinutes",
            o.qc_checkpoint AS "qcCheckpoint", o.status, o.completed_quantity AS "completedQuantity", o.scrap_quantity AS "scrapQuantity", o.actual_minutes AS "actualMinutes"
       FROM work_order_operations o JOIN work_centres w ON w.id = o.work_centre_id WHERE o.work_order_id = $1 ORDER BY o.op_no`,
    [id],
  );
  const outs = await db.query(
    `SELECT o.id, o.kind, o.variant_id AS "variantId", v.sku, p.name AS "productName", o.lot_id AS "lotId", l.code AS "lotCode", l.hold_status AS "holdStatus", o.quantity
       FROM work_order_outputs o JOIN product_variants v ON v.id = o.variant_id JOIN products p ON p.id = v.product_id
       LEFT JOIN stock_lots l ON l.id = o.lot_id WHERE o.work_order_id = $1 ORDER BY o.seq`,
    [id],
  );
  const q = (v: string) => normalize(v);
  return {
    ...w.rows[0],
    plannedQuantity: q(w.rows[0].plannedQuantity),
    producedQuantity: q(w.rows[0].producedQuantity),
    components: comps.rows.map((c) => ({
      ...c, requiredQuantity: q(c.requiredQuantity), issuedQuantity: q(c.issuedQuantity), returnedQuantity: q(c.returnedQuantity), allocatedQuantity: q(String(c.allocatedQuantity)),
      allocations: allocs.rows.filter((a) => a.componentId === c.id).map(({ componentId: _c, ...a }) => ({ ...a, quantity: q(a.quantity), issuedQuantity: q(a.issuedQuantity) })),
    })),
    operations: ops.rows.map((o) => ({ ...o, plannedMinutes: Number(o.plannedMinutes), actualMinutes: o.actualMinutes === null ? null : Number(o.actualMinutes), completedQuantity: o.completedQuantity === null ? null : q(o.completedQuantity), scrapQuantity: q(o.scrapQuantity) })),
    outputs: outs.rows.map((o) => ({ ...o, quantity: q(o.quantity) })),
  };
}

/** Planned versus actual consumption and output, judged against the order's tolerance. */
export async function reconcile(db: Db | Tx, organizationId: string, id: string) {
  const w = await db.query<Wo & { wo_number: string }>(
    `SELECT id, wo_number, status, bom_id, planned_quantity, produced_quantity, bom_output_quantity, expected_yield_bps, tolerance_bps FROM work_orders WHERE id = $1 AND organization_id = $2`,
    [id, organizationId],
  );
  const wo = w.rows[0];
  if (!wo) throw notFound('Work order');
  const comps = await db.query<{ variant_id: string; sku: string; line_no: number; required_quantity: string; issued_quantity: string; returned_quantity: string; scrap_bps: number; line_quantity: string; allocated: string }>(
    `SELECT c.variant_id, (SELECT sku FROM product_variants WHERE id = c.variant_id) AS sku, c.line_no, c.required_quantity, c.issued_quantity, c.returned_quantity, bc.scrap_bps, bc.quantity AS line_quantity,
            COALESCE((SELECT sum(a.quantity) FROM work_order_allocations a WHERE a.component_id = c.id), 0) AS allocated
       FROM work_order_components c JOIN bom_components bc ON bc.bom_id = $2 AND bc.variant_id = c.variant_id
      WHERE c.work_order_id = $1 ORDER BY c.line_no`,
    [id, wo.bom_id],
  );
  let outside = false;
  const components = comps.rows.map((c) => {
    const net = toScaled(c.issued_quantity) - toScaled(c.returned_quantity);
    // What this much good output should have consumed, including line scrap and the BOM's expected yield.
    const expected = toScaled(requiredQuantity(normalize(c.line_quantity), normalize(wo.produced_quantity), normalize(wo.bom_output_quantity), c.scrap_bps, wo.expected_yield_bps));
    const ok = withinTolerance(net, expected, wo.tolerance_bps);
    if (!ok) outside = true;
    const variance = net - expected;
    return {
      lineNo: c.line_no, variantId: c.variant_id, sku: c.sku, required: normalize(c.required_quantity), allocated: normalize(String(c.allocated)),
      issued: normalize(c.issued_quantity), returned: normalize(c.returned_quantity), netConsumed: fromScaled(net),
      expectedForOutput: fromScaled(expected), variance: fromScaled(variance),
      status: ok ? 'within_tolerance' : variance > 0n ? 'over' : 'under',
    };
  });
  const ops = await db.query<{ planned: string | null; actual: string | null; scrap: string }>(
    'SELECT sum(planned_minutes) AS planned, sum(actual_minutes) AS actual, COALESCE(sum(scrap_quantity), 0) AS scrap FROM work_order_operations WHERE work_order_id = $1',
    [id],
  );
  const by = await db.query<{ variant_id: string; qty: string }>(`SELECT variant_id, sum(quantity) AS qty FROM work_order_outputs WHERE work_order_id = $1 AND kind = 'byproduct' GROUP BY variant_id`, [id]);
  const q = await db.query<{ code: string; hold_status: string }>(
    `SELECT l.code, l.hold_status FROM work_order_outputs o JOIN stock_lots l ON l.id = o.lot_id WHERE o.work_order_id = $1 AND o.kind = 'output' AND l.hold_status = 'quarantined'`,
    [id],
  );
  const planned = toScaled(wo.planned_quantity);
  const produced = toScaled(wo.produced_quantity);
  return {
    workOrderId: id, woNumber: wo.wo_number, status: wo.status,
    toleranceBps: wo.tolerance_bps,
    components,
    output: {
      planned: normalize(wo.planned_quantity), produced: normalize(wo.produced_quantity),
      yieldBps: planned === 0n ? 0 : Number((produced * 10000n) / planned), expectedYieldBps: wo.expected_yield_bps,
      scrapQuantity: normalize(ops.rows[0]!.scrap), quarantinedOutputLots: q.rows.map((r) => r.code),
    },
    byproducts: by.rows.map((b) => ({ variantId: b.variant_id, quantity: normalize(b.qty) })),
    minutes: { planned: Number(ops.rows[0]!.planned ?? 0), actual: Number(ops.rows[0]!.actual ?? 0) },
    outsideTolerance: outside,
    note: 'Quantities only. No cost, WIP valuation or variance accounting is produced until a costing policy is approved.',
  };
}

export const workOrderRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/manufacturing/work-orders', async (req, reply) => {
    const body = createBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      await authorize(tx, actor, 'manufacturing.plan', { kind: 'location', locationId: body.locationId });
      const loc = await loadStockLocation(tx, actor.organizationId, body.locationId);
      const bom = await tx.query<{ id: string; status: string; output_variant_id: string; output_quantity: string; expected_yield_bps: number; requires_qc: boolean }>(
        'SELECT id, status, output_variant_id, output_quantity, expected_yield_bps, requires_qc FROM boms WHERE id = $1 AND organization_id = $2',
        [body.bomId, actor.organizationId],
      );
      const b = bom.rows[0];
      if (!b) throw notFound('BOM');
      if (b.status !== 'active') throw conflict('Work orders run on an active BOM version');
      const out = await loadVariant(tx, actor.organizationId, b.output_variant_id);
      const planned = await resolveQuantity(tx, out, body.quantity, body.unitId);

      const ops = await tx.query<{ op_no: number; name: string; work_centre_id: string; setup_minutes: number; run_minutes_per_unit: string; qc_checkpoint: boolean; location_id: string }>(
        `SELECT o.op_no, o.name, o.work_centre_id, o.setup_minutes, o.run_minutes_per_unit, o.qc_checkpoint, w.location_id
           FROM bom_operations o JOIN work_centres w ON w.id = o.work_centre_id WHERE o.bom_id = $1 ORDER BY o.op_no`,
        [b.id],
      );
      if (ops.rows.some((o) => o.location_id !== loc.id)) throw invalid('This BOM routes through work centres at another location');

      const number = await nextDocumentNumber(tx, actor.organizationId, loc.legalEntityId, 'WO', 'WO');
      const wo = await tx.query<{ id: string }>(
        `INSERT INTO work_orders (organization_id, legal_entity_id, location_id, wo_number, bom_id, output_variant_id, planned_quantity, bom_output_quantity,
                                  expected_yield_bps, requires_qc, tolerance_bps, over_production_bps, planned_start, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [actor.organizationId, loc.legalEntityId, loc.id, number, b.id, b.output_variant_id, planned, b.output_quantity, b.expected_yield_bps, b.requires_qc,
         body.toleranceBps, body.overProductionBps, body.plannedStart ?? null, body.note ?? null, actor.userId],
      );
      const woId = wo.rows[0]!.id;

      const comps = await tx.query<{ line_no: number; variant_id: string; quantity: string; scrap_bps: number }>('SELECT line_no, variant_id, quantity, scrap_bps FROM bom_components WHERE bom_id = $1 ORDER BY line_no', [b.id]);
      for (const c of comps.rows) {
        await tx.query(
          'INSERT INTO work_order_components (work_order_id, line_no, variant_id, required_quantity) VALUES ($1,$2,$3,$4)',
          [woId, c.line_no, c.variant_id, requiredQuantity(normalize(c.quantity), planned, normalize(b.output_quantity), c.scrap_bps, b.expected_yield_bps)],
        );
      }
      for (const o of ops.rows) {
        // minutes = setup + run per unit x planned quantity, to 2 decimals half-up
        const runCents = roundDiv(toScaled(o.run_minutes_per_unit, 4) * toScaled(planned), 10n ** 8n);
        const cents = BigInt(o.setup_minutes) * 100n + runCents;
        await tx.query(
          'INSERT INTO work_order_operations (work_order_id, op_no, name, work_centre_id, planned_minutes, qc_checkpoint) VALUES ($1,$2,$3,$4,$5,$6)',
          [woId, o.op_no, o.name, o.work_centre_id, fromScaled(cents, 2), o.qc_checkpoint],
        );
      }
      await audit(tx, req, 'wo.create', 'work_order', woId, { woNumber: number, bomId: b.id, planned });
      return { status: 201, body: await readWorkOrder(tx, actor.organizationId, woId) };
    });
  });

  app.get('/manufacturing/work-orders/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const wo = await readWorkOrder(db, req.actor.organizationId, id);
    await authorize(db, req.actor, 'manufacturing.read', { kind: 'location', locationId: wo.locationId });
    return wo;
  });

  app.get('/manufacturing/work-orders', async (req) => {
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const grants = await grantsFor(db, req.actor, 'manufacturing.read');
    const scope = scopeFilter(grants, 4);
    const { rows } = await db.query(
      `SELECT w.id, w.wo_number AS "woNumber", w.status, w.location_id AS "locationId", w.output_variant_id AS "outputVariantId",
              v.sku AS "outputSku", p.name AS "outputProductName", w.planned_quantity AS "plannedQuantity", w.produced_quantity AS "producedQuantity"
         FROM work_orders w JOIN locations l ON l.id = w.location_id JOIN product_variants v ON v.id = w.output_variant_id JOIN products p ON p.id = v.product_id
        WHERE w.organization_id = $1 AND ($2::text IS NULL OR w.status = $2) AND ${scope.clause}
        ORDER BY w.wo_number DESC LIMIT $3`,
      [req.actor.organizationId, q.status ?? null, q.limit, ...scope.params],
    );
    return rows.map((r) => ({ ...r, plannedQuantity: normalize(r.plannedQuantity), producedQuantity: normalize(r.producedQuantity) }));
  });

  // Reserves the materials. If anything is short, nothing is reserved and the shortages are listed.
  app.post('/manufacturing/work-orders/:id/release', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const wo = await lockWo(tx, actor.organizationId, id);
      await authorize(tx, actor, 'manufacturing.plan', { kind: 'location', locationId: wo.location_id });
      if (wo.status !== 'draft') throw conflict(`Work order is ${wo.status}`);

      const comps = await tx.query<{ id: string; variant_id: string; required_quantity: string }>('SELECT id, variant_id, required_quantity FROM work_order_components WHERE work_order_id = $1 ORDER BY line_no', [id]);
      const needs: (Need & { componentId: string })[] = [];
      for (const c of comps.rows) {
        const v = await loadVariant(tx, actor.organizationId, c.variant_id);
        needs.push({ componentId: c.id, variantId: v.id, sku: v.sku, tracking: v.tracking, required: normalize(c.required_quantity) });
      }
      const plan = await planAllocation(tx, wo.location_id, needs);
      if (plan.shortages.length) throw shortage('Not enough free material to release this work order', { shortages: plan.shortages });

      for (const a of plan.allocations) {
        const need = needs.find((n) => n.variantId === a.variantId)!;
        const reservationId = await createReservation(tx, {
          organizationId: actor.organizationId, userId: actor.userId, locationId: wo.location_id, variantId: a.variantId, lotId: a.lotId,
          quantity: a.quantity, referenceType: 'work_order', referenceId: id,
        });
        await tx.query('INSERT INTO work_order_allocations (work_order_id, component_id, lot_id, quantity, reservation_id) VALUES ($1,$2,$3,$4,$5)', [id, need.componentId, a.lotId, a.quantity, reservationId]);
      }
      await tx.query(`UPDATE work_orders SET status = 'released', released_by = $2, released_at = now() WHERE id = $1`, [id, actor.userId]);
      await audit(tx, req, 'wo.release', 'work_order', id);
      return { status: 200, body: await readWorkOrder(tx, actor.organizationId, id) };
    });
  });

  app.post('/manufacturing/work-orders/:id/cancel', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const wo = await lockWo(tx, actor.organizationId, id);
      await authorize(tx, actor, 'manufacturing.plan', { kind: 'location', locationId: wo.location_id });
      if (!['draft', 'released'].includes(wo.status)) throw conflict(`Work order is ${wo.status}; return material and complete it instead`);
      const used = await tx.query('SELECT 1 FROM work_order_components WHERE work_order_id = $1 AND issued_quantity > 0', [id]);
      if (used.rowCount) throw conflict('Material has been issued; return it before cancelling');
      await releaseReferenceReservations(tx, 'work_order', id);
      await tx.query(`UPDATE work_orders SET status = 'cancelled' WHERE id = $1`, [id]);
      await audit(tx, req, 'wo.cancel', 'work_order', id);
      return { status: 200, body: await readWorkOrder(tx, actor.organizationId, id) };
    });
  });

  app.post('/manufacturing/work-orders/:id/issues', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ lines: moveLines }).parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const wo = await lockWo(tx, actor.organizationId, id);
      const target = { kind: 'location', locationId: wo.location_id } as const;
      await authorize(tx, actor, 'manufacturing.issue', target);
      if (!ACTIVE.includes(wo.status)) throw conflict(`Material can only be issued to a released work order (it is ${wo.status})`);
      const ctx = { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id, reason: 'production', referenceType: 'work_order', referenceId: id };

      for (const line of body.lines) {
        const comp = await tx.query<{ variant_id: string }>('SELECT variant_id FROM work_order_components WHERE id = $1 AND work_order_id = $2 FOR UPDATE', [line.componentId, id]);
        if (!comp.rows[0]) throw notFound('Component');
        const variant = await loadVariant(tx, actor.organizationId, comp.rows[0].variant_id);
        const lotId = await checkLot(tx, actor.organizationId, variant, line.lotId);
        const qty = await resolveQuantity(tx, variant, line.quantity, line.unitId);

        const alloc = await tx.query<{ id: string; quantity: string; issued_quantity: string; reservation_id: string }>(
          `SELECT id, quantity, issued_quantity, reservation_id FROM work_order_allocations
            WHERE component_id = $1 AND lot_id IS NOT DISTINCT FROM $2::uuid FOR UPDATE`,
          [line.componentId, lotId],
        );
        const a = alloc.rows[0];
        const room = a ? toScaled(a.quantity) - toScaled(a.issued_quantity) : 0n;
        const fromReserved = toScaled(qty) < room ? toScaled(qty) : room;
        const excess = toScaled(qty) - fromReserved;

        if (excess > 0n) {
          if (!line.exceptionReason) throw conflict('Issue exceeds the material reserved for this work order; an approved exception is required');
          if (!(await can(tx, actor, 'manufacturing.issue.exception', target))) throw forbidden('You are not permitted to approve issue beyond the reservation');
        }
        if (fromReserved > 0n) {
          await consumeReservation(tx, ctx, a!.reservation_id, fromReserved === toScaled(qty) ? qty : fromScaled(fromReserved), 'production_issue');
          await tx.query('UPDATE work_order_allocations SET issued_quantity = issued_quantity + $2::numeric WHERE id = $1', [a!.id, fromScaled(fromReserved)]);
          await tx.query(`INSERT INTO work_order_material_moves (work_order_id, component_id, lot_id, kind, quantity, actor_user_id) VALUES ($1,$2,$3,'issue',$4,$5)`, [id, line.componentId, lotId, fromScaled(fromReserved), actor.userId]);
        }
        if (excess > 0n) {
          // Free stock only: the balance constraint stops this from touching anything reserved for another document.
          await postMovements(tx, ctx, [{ locationId: wo.location_id, variantId: variant.id, lotId, state: 'on_hand', delta: `-${fromScaled(excess)}`, type: 'production_issue' }]);
          await tx.query(
            `INSERT INTO work_order_material_moves (work_order_id, component_id, lot_id, kind, quantity, is_exception, exception_reason, actor_user_id) VALUES ($1,$2,$3,'issue',$4,true,$5,$6)`,
            [id, line.componentId, lotId, fromScaled(excess), line.exceptionReason, actor.userId],
          );
        }
        await tx.query('UPDATE work_order_components SET issued_quantity = issued_quantity + $2::numeric WHERE id = $1', [line.componentId, qty]);
      }
      await tx.query(`UPDATE work_orders SET status = 'in_progress' WHERE id = $1 AND status = 'released'`, [id]);
      await audit(tx, req, 'wo.issue', 'work_order', id, { lines: body.lines });
      return { status: 201, body: await readWorkOrder(tx, actor.organizationId, id) };
    });
  });

  app.post('/manufacturing/work-orders/:id/returns', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ lines: moveLines }).parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const wo = await lockWo(tx, actor.organizationId, id);
      await authorize(tx, actor, 'manufacturing.issue', { kind: 'location', locationId: wo.location_id });
      if (!['released', 'in_progress', 'completed'].includes(wo.status)) throw conflict(`Work order is ${wo.status}`);
      const postings: Posting[] = [];
      for (const line of body.lines) {
        const comp = await tx.query<{ variant_id: string }>('SELECT variant_id FROM work_order_components WHERE id = $1 AND work_order_id = $2 FOR UPDATE', [line.componentId, id]);
        if (!comp.rows[0]) throw notFound('Component');
        const variant = await loadVariant(tx, actor.organizationId, comp.rows[0].variant_id);
        const lotId = await checkLot(tx, actor.organizationId, variant, line.lotId, { allowQuarantined: true });
        const qty = await resolveQuantity(tx, variant, line.quantity, line.unitId);
        const net = await tx.query<{ net: string }>(
          `SELECT COALESCE(sum(CASE kind WHEN 'issue' THEN quantity ELSE -quantity END), 0) AS net FROM work_order_material_moves
            WHERE component_id = $1 AND lot_id IS NOT DISTINCT FROM $2::uuid`,
          [line.componentId, lotId],
        );
        if (toScaled(qty) > toScaled(net.rows[0]!.net)) throw conflict('Return quantity exceeds what was issued from that lot and not yet returned');
        await tx.query(`INSERT INTO work_order_material_moves (work_order_id, component_id, lot_id, kind, quantity, actor_user_id) VALUES ($1,$2,$3,'return',$4,$5)`, [id, line.componentId, lotId, qty, actor.userId]);
        await tx.query('UPDATE work_order_components SET returned_quantity = returned_quantity + $2::numeric WHERE id = $1', [line.componentId, qty]);
        postings.push({ locationId: wo.location_id, variantId: variant.id, lotId, state: 'on_hand', delta: qty, type: 'production_return' });
      }
      await postMovements(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id, reason: 'unused production material', referenceType: 'work_order', referenceId: id }, postings);
      await audit(tx, req, 'wo.return', 'work_order', id, { lines: body.lines });
      return { status: 201, body: await readWorkOrder(tx, actor.organizationId, id) };
    });
  });

  app.post('/manufacturing/work-orders/:id/operations/:opNo/start', async (req, reply) => {
    const { id, opNo } = z.object({ id: uuid, opNo: z.coerce.number().int() }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const wo = await lockWo(tx, actor.organizationId, id);
      await authorize(tx, actor, 'manufacturing.operate', { kind: 'location', locationId: wo.location_id });
      if (!ACTIVE.includes(wo.status)) throw conflict(`Work order is ${wo.status}`);
      const op = await tx.query<{ status: string }>('SELECT status FROM work_order_operations WHERE work_order_id = $1 AND op_no = $2 FOR UPDATE', [id, opNo]);
      if (!op.rows[0]) throw notFound('Operation');
      if (op.rows[0].status !== 'pending') throw conflict(`Operation is ${op.rows[0].status}`);
      const before = await tx.query('SELECT 1 FROM work_order_operations WHERE work_order_id = $1 AND op_no < $2 AND status <> \'done\'', [id, opNo]);
      if (before.rowCount) throw conflict('Earlier operations must be completed first');
      await tx.query(`UPDATE work_order_operations SET status = 'in_progress', started_by = $3, started_at = now() WHERE work_order_id = $1 AND op_no = $2`, [id, opNo, actor.userId]);
      await tx.query(`UPDATE work_orders SET status = 'in_progress' WHERE id = $1 AND status = 'released'`, [id]);
      await audit(tx, req, 'wo.op_start', 'work_order', id, { opNo });
      return { status: 200, body: await readWorkOrder(tx, actor.organizationId, id) };
    });
  });

  app.post('/manufacturing/work-orders/:id/operations/:opNo/complete', async (req, reply) => {
    const { id, opNo } = z.object({ id: uuid, opNo: z.coerce.number().int() }).parse(req.params);
    const body = z.object({ completedQuantity: quantityField, scrapQuantity: quantityField.default('0'), minutes: z.number().min(0).max(100000).optional() }).parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const wo = await lockWo(tx, actor.organizationId, id);
      await authorize(tx, actor, 'manufacturing.operate', { kind: 'location', locationId: wo.location_id });
      const op = await tx.query<{ status: string; started_at: Date }>('SELECT status, started_at FROM work_order_operations WHERE work_order_id = $1 AND op_no = $2 FOR UPDATE', [id, opNo]);
      if (!op.rows[0]) throw notFound('Operation');
      if (op.rows[0].status !== 'in_progress') throw conflict('Operation has not been started');
      const out = await loadVariant(tx, actor.organizationId, wo.output_variant_id);
      const done = await resolveQuantity(tx, out, body.completedQuantity);
      const scrap = toScaled(body.scrapQuantity) === 0n ? '0' : await resolveQuantity(tx, out, body.scrapQuantity);
      const minutes = body.minutes ?? Math.round(((Date.now() - op.rows[0].started_at.getTime()) / 60000) * 100) / 100;
      await tx.query(
        `UPDATE work_order_operations SET status = 'done', completed_by = $3, completed_at = now(), completed_quantity = $4, scrap_quantity = $5, actual_minutes = $6
          WHERE work_order_id = $1 AND op_no = $2`,
        [id, opNo, actor.userId, done, scrap, minutes],
      );
      await audit(tx, req, 'wo.op_complete', 'work_order', id, { opNo, done, scrap });
      return { status: 200, body: await readWorkOrder(tx, actor.organizationId, id) };
    });
  });

  // Receives finished goods (and declared by-products) into stock, within the over-production allowance.
  app.post('/manufacturing/work-orders/:id/outputs', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = outputBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const wo = await lockWo(tx, actor.organizationId, id);
      await authorize(tx, actor, 'manufacturing.operate', { kind: 'location', locationId: wo.location_id });
      if (!ACTIVE.includes(wo.status)) throw conflict(`Work order is ${wo.status}`);
      const out = await loadVariant(tx, actor.organizationId, wo.output_variant_id);
      const qty = await resolveQuantity(tx, out, body.quantity, body.unitId);

      const limit = (toScaled(wo.planned_quantity) * BigInt(10000 + wo.over_production_bps)) / 10000n;
      if (toScaled(wo.produced_quantity) + toScaled(qty) > limit) throw conflict('Output would exceed the planned quantity plus the over-production allowance');

      const postings: Posting[] = [];
      let lotId: string | null = null;
      if (out.tracking !== 'none' && body.lotCode && wo.requires_qc) {
        const exists = await tx.query('SELECT 1 FROM stock_lots WHERE organization_id = $1 AND variant_id = $2 AND code = $3', [actor.organizationId, out.id, body.lotCode]);
        if (exists.rowCount) throw conflict('Output that needs QC must go into a new lot or roll, so it can be held on its own');
      }
      lotId = await resolveReceiptLot(tx, actor.organizationId, out, body.lotCode, qty);
      if (wo.requires_qc && lotId) {
        await tx.query(
          `UPDATE stock_lots SET hold_status = 'quarantined', hold_reason = 'Awaiting QC inspection', held_by = $2, held_at = now() WHERE id = $1`,
          [lotId, actor.userId],
        );
      }
      postings.push({ locationId: wo.location_id, variantId: out.id, lotId, state: 'on_hand', delta: qty, type: 'production_output' });
      await tx.query(`INSERT INTO work_order_outputs (work_order_id, kind, variant_id, lot_id, quantity, actor_user_id) VALUES ($1,'output',$2,$3,$4,$5)`, [id, out.id, lotId, qty, actor.userId]);

      for (const bp of body.byproducts) {
        const declared = await tx.query('SELECT 1 FROM bom_byproducts WHERE bom_id = $1 AND variant_id = $2', [wo.bom_id, bp.variantId]);
        if (!declared.rowCount) throw invalid('That product is not a declared by-product of this BOM');
        const v = await loadVariant(tx, actor.organizationId, bp.variantId);
        const bq = await resolveQuantity(tx, v, bp.quantity, bp.unitId);
        const bl = await resolveReceiptLot(tx, actor.organizationId, v, bp.lotCode, bq);
        postings.push({ locationId: wo.location_id, variantId: v.id, lotId: bl, state: 'on_hand', delta: bq, type: 'production_output' });
        await tx.query(`INSERT INTO work_order_outputs (work_order_id, kind, variant_id, lot_id, quantity, actor_user_id) VALUES ($1,'byproduct',$2,$3,$4,$5)`, [id, v.id, bl, bq, actor.userId]);
      }
      await postMovements(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id, reason: 'production output', referenceType: 'work_order', referenceId: id }, postings);
      await tx.query(`UPDATE work_orders SET produced_quantity = produced_quantity + $2::numeric, status = 'in_progress' WHERE id = $1`, [id, qty]);
      await audit(tx, req, 'wo.output', 'work_order', id, { quantity: qty, lotId });
      return { status: 201, body: await readWorkOrder(tx, actor.organizationId, id) };
    });
  });

  app.post('/manufacturing/work-orders/:id/complete', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const wo = await lockWo(tx, actor.organizationId, id);
      await authorize(tx, actor, 'manufacturing.close', { kind: 'location', locationId: wo.location_id });
      if (wo.status !== 'in_progress') throw conflict(`Only an in-progress work order can be completed (it is ${wo.status})`);
      const open = await tx.query(`SELECT 1 FROM work_order_operations WHERE work_order_id = $1 AND status <> 'done'`, [id]);
      if (open.rowCount) throw conflict('All operations must be completed first');
      await releaseReferenceReservations(tx, 'work_order', id);   // frees anything reserved but never issued
      await tx.query(`UPDATE work_orders SET status = 'completed', completed_at = now() WHERE id = $1`, [id]);
      await audit(tx, req, 'wo.complete', 'work_order', id);
      return { status: 200, body: await readWorkOrder(tx, actor.organizationId, id) };
    });
  });

  app.get('/manufacturing/work-orders/:id/reconciliation', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const wo = await readWorkOrder(db, req.actor.organizationId, id);
    await authorize(db, req.actor, 'manufacturing.read', { kind: 'location', locationId: wo.locationId });
    return reconcile(db, req.actor.organizationId, id);
  });

  // Closing needs the numbers to be inside tolerance, or a recorded reason for the variance.
  app.post('/manufacturing/work-orders/:id/close', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ varianceReason: z.string().trim().min(5).max(1000).optional() }).parse(req.body ?? {});
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const wo = await lockWo(tx, actor.organizationId, id);
      await authorize(tx, actor, 'manufacturing.close', { kind: 'location', locationId: wo.location_id });
      if (wo.status !== 'completed') throw conflict(`Complete the work order before closing it (it is ${wo.status})`);
      const rec = await reconcile(tx, actor.organizationId, id);
      if (rec.outsideTolerance && !body.varianceReason) {
        throw new AppError(422, 'variance_reason_required', 'Material use is outside tolerance; give a variance reason to close', rec);
      }
      await tx.query(`UPDATE work_orders SET status = 'closed', closed_by = $2, closed_at = now(), variance_reason = $3 WHERE id = $1`, [id, actor.userId, rec.outsideTolerance ? body.varianceReason : null]);
      await audit(tx, req, 'wo.close', 'work_order', id, { outsideTolerance: rec.outsideTolerance, varianceReason: body.varianceReason });
      return { status: 200, body: { ...(await readWorkOrder(tx, actor.organizationId, id)), reconciliation: rec } };
    });
  });
};
