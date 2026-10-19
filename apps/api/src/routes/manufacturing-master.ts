import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, authorizeAnywhere, can, grantsFor } from '../auth/authorize.js';
import { withTx, type Db, type Tx } from '../db.js';
import { fromScaled, normalize, toScaled } from '../domain/decimal.js';
import { requiredQuantity } from '../domain/manufacturing.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { audit, loadStockLocation, loadVariant, quantityField, resolveQuantity, scopeFilter, uuid } from '../inventory/common.js';
import { planAllocation } from '../manufacturing/availability.js';

const bomBody = z.object({
  outputVariantId: uuid,
  outputQuantity: quantityField,
  outputUnitId: uuid.optional(),
  expectedYieldBps: z.number().int().min(1).max(10000).default(10000),
  requiresQc: z.boolean().default(false),
  note: z.string().max(1000).optional(),
  components: z
    .array(z.object({ variantId: uuid, quantity: quantityField, unitId: uuid.optional(), scrapBps: z.number().int().min(0).max(10000).default(0) }))
    .min(1)
    .max(200),
  byproducts: z.array(z.object({ variantId: uuid, quantity: quantityField, unitId: uuid.optional() })).max(50).default([]),
  operations: z
    .array(
      z.object({
        opNo: z.number().int().min(1).max(9999),
        name: z.string().min(1).max(100),
        workCentreId: uuid,
        setupMinutes: z.number().int().min(0).default(0),
        runMinutesPerUnit: z.string().regex(/^\d+(\.\d{1,4})?$/).default('0'),
        qcCheckpoint: z.boolean().default(false),
      }),
    )
    .max(50)
    .default([]),
});
type BomInput = z.infer<typeof bomBody>;

async function writeBom(tx: Tx, organizationId: string, bomId: string, b: BomInput): Promise<void> {
  const out = await loadVariant(tx, organizationId, b.outputVariantId);
  if (b.requiresQc && out.tracking === 'none') throw invalid('A BOM that requires QC must produce a lot- or roll-tracked variant, so output can be held');
  const seen = new Set<string>();
  await tx.query('DELETE FROM bom_components WHERE bom_id = $1', [bomId]);
  await tx.query('DELETE FROM bom_byproducts WHERE bom_id = $1', [bomId]);
  await tx.query('DELETE FROM bom_operations WHERE bom_id = $1', [bomId]);
  for (const [i, c] of b.components.entries()) {
    if (c.variantId === b.outputVariantId) throw invalid('A product cannot be a component of itself');
    if (seen.has(c.variantId)) throw invalid('A component appears twice; combine the lines');
    seen.add(c.variantId);
    const v = await loadVariant(tx, organizationId, c.variantId);
    const qty = await resolveQuantity(tx, v, c.quantity, c.unitId);
    await tx.query('INSERT INTO bom_components (bom_id, line_no, variant_id, quantity, scrap_bps) VALUES ($1,$2,$3,$4,$5)', [bomId, i + 1, v.id, qty, c.scrapBps]);
  }
  for (const [i, p] of b.byproducts.entries()) {
    if (p.variantId === b.outputVariantId) throw invalid('The main output cannot also be a by-product');
    const v = await loadVariant(tx, organizationId, p.variantId);
    const qty = await resolveQuantity(tx, v, p.quantity, p.unitId);
    await tx.query('INSERT INTO bom_byproducts (bom_id, line_no, variant_id, quantity) VALUES ($1,$2,$3,$4)', [bomId, i + 1, v.id, qty]);
  }
  for (const o of b.operations) {
    const wc = await tx.query('SELECT 1 FROM work_centres WHERE id = $1 AND organization_id = $2 AND status = \'active\'', [o.workCentreId, organizationId]);
    if (!wc.rowCount) throw invalid('Unknown or inactive work centre');
    await tx.query(
      'INSERT INTO bom_operations (bom_id, op_no, name, work_centre_id, setup_minutes, run_minutes_per_unit, qc_checkpoint) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [bomId, o.opNo, o.name, o.workCentreId, o.setupMinutes, o.runMinutesPerUnit, o.qcCheckpoint],
    );
  }
}

export async function readBom(db: Db | Tx, organizationId: string, id: string) {
  const b = await db.query(
    `SELECT id, output_variant_id AS "outputVariantId", version, status, output_quantity AS "outputQuantity",
            expected_yield_bps AS "expectedYieldBps", requires_qc AS "requiresQc", note,
            created_by AS "createdBy", approved_by AS "approvedBy", approved_at AS "approvedAt"
       FROM boms WHERE id = $1 AND organization_id = $2`,
    [id, organizationId],
  );
  if (!b.rows[0]) throw notFound('BOM');
  const comps = await db.query('SELECT line_no AS "lineNo", variant_id AS "variantId", quantity, scrap_bps AS "scrapBps" FROM bom_components WHERE bom_id = $1 ORDER BY line_no', [id]);
  const by = await db.query('SELECT line_no AS "lineNo", variant_id AS "variantId", quantity FROM bom_byproducts WHERE bom_id = $1 ORDER BY line_no', [id]);
  const ops = await db.query(
    `SELECT op_no AS "opNo", name, work_centre_id AS "workCentreId", setup_minutes AS "setupMinutes",
            run_minutes_per_unit AS "runMinutesPerUnit", qc_checkpoint AS "qcCheckpoint" FROM bom_operations WHERE bom_id = $1 ORDER BY op_no`,
    [id],
  );
  return {
    ...b.rows[0],
    outputQuantity: normalize(b.rows[0].outputQuantity),
    components: comps.rows.map((c) => ({ ...c, quantity: normalize(c.quantity) })),
    byproducts: by.rows.map((c) => ({ ...c, quantity: normalize(c.quantity) })),
    operations: ops.rows.map((o) => ({ ...o, runMinutesPerUnit: normalize(o.runMinutesPerUnit, 4) })),
  };
}

export const manufacturingMasterRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/manufacturing/work-centres', async (req, reply) => {
    const body = z.object({ locationId: uuid, code: z.string().regex(/^[A-Z0-9_-]{2,20}$/), name: z.string().min(1).max(100) }).parse(req.body);
    const { actor } = req;
    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'manufacturing.workcentre.manage', { kind: 'location', locationId: body.locationId });
      const loc = await loadStockLocation(tx, actor.organizationId, body.locationId);
      const { rows } = await tx.query(
        `INSERT INTO work_centres (organization_id, location_id, code, name) VALUES ($1,$2,$3,$4) RETURNING id, location_id AS "locationId", code, name, status`,
        [actor.organizationId, loc.id, body.code, body.name],
      );
      await audit(tx, req, 'work_centre.create', 'work_centre', rows[0].id, rows[0]);
      return rows[0];
    });
    return reply.status(201).send(created);
  });

  app.get('/manufacturing/work-centres', async (req) => {
    const grants = await grantsFor(db, req.actor, 'manufacturing.read');
    const scope = scopeFilter(grants, 2);
    const { rows } = await db.query(
      `SELECT w.id, w.location_id AS "locationId", w.code, w.name, w.status FROM work_centres w JOIN locations l ON l.id = w.location_id
        WHERE w.organization_id = $1 AND ${scope.clause} ORDER BY w.code`,
      [req.actor.organizationId, ...scope.params],
    );
    return rows;
  });

  app.post('/manufacturing/boms', async (req, reply) => {
    const body = bomBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      await authorize(tx, actor, 'manufacturing.bom.manage', { kind: 'organization' });
      const out = await loadVariant(tx, actor.organizationId, body.outputVariantId);
      const outQty = await resolveQuantity(tx, out, body.outputQuantity, body.outputUnitId);
      // Serialize version numbering per output product.
      await tx.query('SELECT 1 FROM product_variants WHERE id = $1 FOR UPDATE', [out.id]);
      const v = await tx.query<{ next: number }>('SELECT COALESCE(max(version), 0) + 1 AS next FROM boms WHERE organization_id = $1 AND output_variant_id = $2', [actor.organizationId, out.id]);
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO boms (organization_id, output_variant_id, version, output_quantity, expected_yield_bps, requires_qc, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [actor.organizationId, out.id, v.rows[0]!.next, outQty, body.expectedYieldBps, body.requiresQc, body.note ?? null, actor.userId],
      );
      await writeBom(tx, actor.organizationId, ins.rows[0]!.id, body);
      await audit(tx, req, 'bom.create', 'bom', ins.rows[0]!.id, { outputVariantId: out.id, version: v.rows[0]!.next });
      return { status: 201, body: await readBom(tx, actor.organizationId, ins.rows[0]!.id) };
    });
  });

  app.put('/manufacturing/boms/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = bomBody.parse(req.body);
    const { actor } = req;
    return withTx(db, async (tx) => {
      await authorize(tx, actor, 'manufacturing.bom.manage', { kind: 'organization' });
      const b = await tx.query<{ status: string; output_variant_id: string }>('SELECT status, output_variant_id FROM boms WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, actor.organizationId]);
      if (!b.rows[0]) throw notFound('BOM');
      if (b.rows[0].status !== 'draft') throw conflict('Only draft BOMs can be edited; create a new version');
      if (b.rows[0].output_variant_id !== body.outputVariantId) throw invalid('The output product of a BOM cannot change');
      const out = await loadVariant(tx, actor.organizationId, body.outputVariantId);
      const outQty = await resolveQuantity(tx, out, body.outputQuantity, body.outputUnitId);
      await tx.query('UPDATE boms SET output_quantity = $2, expected_yield_bps = $3, requires_qc = $4, note = $5 WHERE id = $1', [id, outQty, body.expectedYieldBps, body.requiresQc, body.note ?? null]);
      await writeBom(tx, actor.organizationId, id, body);
      await audit(tx, req, 'bom.update', 'bom', id);
      return readBom(tx, actor.organizationId, id);
    });
  });

  app.post('/manufacturing/boms/:id/approve', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      await authorize(tx, actor, 'manufacturing.bom.approve', { kind: 'organization' });
      const b = await tx.query<{ status: string; created_by: string; output_variant_id: string }>('SELECT status, created_by, output_variant_id FROM boms WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, actor.organizationId]);
      const row = b.rows[0];
      if (!row) throw notFound('BOM');
      if (row.status !== 'draft') throw conflict(`BOM is already ${row.status}`);
      if (row.created_by === actor.userId) throw forbidden('You cannot approve a BOM you created');

      // A product must not end up inside its own bill of materials, however deep.
      const cycle = await tx.query(
        `WITH RECURSIVE reach(variant_id, depth) AS (
           SELECT variant_id, 1 FROM bom_components WHERE bom_id = $1
           UNION
           SELECT c.variant_id, r.depth + 1 FROM reach r
             JOIN boms b ON b.output_variant_id = r.variant_id AND b.status = 'active' AND b.organization_id = $2
             JOIN bom_components c ON c.bom_id = b.id WHERE r.depth < 25
         ) SELECT 1 FROM reach WHERE variant_id = $3 LIMIT 1`,
        [id, actor.organizationId, row.output_variant_id],
      );
      if (cycle.rowCount) throw invalid('This BOM would make the product part of its own bill of materials');

      await tx.query(`UPDATE boms SET status = 'retired' WHERE organization_id = $1 AND output_variant_id = $2 AND status = 'active'`, [actor.organizationId, row.output_variant_id]);
      await tx.query(`UPDATE boms SET status = 'active', approved_by = $2, approved_at = now() WHERE id = $1`, [id, actor.userId]);
      await audit(tx, req, 'bom.approve', 'bom', id);
      return { status: 200, body: await readBom(tx, actor.organizationId, id) };
    });
  });

  app.post('/manufacturing/boms/:id/retire', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      await authorize(tx, actor, 'manufacturing.bom.approve', { kind: 'organization' });
      const r = await tx.query(`UPDATE boms SET status = 'retired' WHERE id = $1 AND organization_id = $2 AND status = 'active' RETURNING id`, [id, actor.organizationId]);
      if (!r.rowCount) throw conflict('Only active BOMs can be retired');
      await audit(tx, req, 'bom.retire', 'bom', id);
      return { status: 200, body: await readBom(tx, actor.organizationId, id) };
    });
  });

  app.get('/manufacturing/boms/:id', async (req) => {
    await authorizeAnywhere(db, req.actor, 'manufacturing.read');
    return readBom(db, req.actor.organizationId, z.object({ id: uuid }).parse(req.params).id);
  });

  app.get('/manufacturing/boms', async (req) => {
    await authorizeAnywhere(db, req.actor, 'manufacturing.read');
    const q = z.object({ outputVariantId: uuid.optional(), status: z.enum(['draft', 'active', 'retired']).optional() }).parse(req.query);
    const { rows } = await db.query(
      `SELECT id, output_variant_id AS "outputVariantId", version, status FROM boms
        WHERE organization_id = $1 AND ($2::uuid IS NULL OR output_variant_id = $2) AND ($3::text IS NULL OR status = $3)
        ORDER BY output_variant_id, version DESC`,
      [req.actor.organizationId, q.outputVariantId ?? null, q.status ?? null],
    );
    return rows;
  });

  // Single-level requirements for making a quantity at a location: what is needed, what is free, what is
  // already on order. No reservation is made.
  app.get('/manufacturing/requirements', async (req) => {
    const q = z.object({ bomId: uuid, quantity: quantityField, unitId: uuid.optional(), locationId: uuid }).parse(req.query);
    await authorize(db, req.actor, 'manufacturing.read', { kind: 'location', locationId: q.locationId });
    const bom = await readBom(db, req.actor.organizationId, q.bomId);
    const out = await loadVariant(db as unknown as Tx, req.actor.organizationId, bom.outputVariantId);
    const planned = await resolveQuantity(db as unknown as Tx, out, q.quantity, q.unitId);

    const needs = [];
    for (const c of bom.components) {
      const v = await loadVariant(db as unknown as Tx, req.actor.organizationId, c.variantId);
      needs.push({ variantId: v.id, sku: v.sku, tracking: v.tracking, required: requiredQuantity(c.quantity, planned, bom.outputQuantity, c.scrapBps, bom.expectedYieldBps) });
    }
    const plan = await planAllocation(db as unknown as Tx, q.locationId, needs);
    const onOrder = await db.query<{ variant_id: string; qty: string }>(
      `SELECT l.variant_id, sum(GREATEST(l.quantity - l.received_quantity, 0)) AS qty FROM purchase_orders p JOIN purchase_order_lines l ON l.purchase_order_id = p.id
        WHERE p.organization_id = $1 AND p.destination_location_id = $2 AND p.status IN ('approved', 'partially_received') GROUP BY l.variant_id`,
      [req.actor.organizationId, q.locationId],
    );
    const incoming = new Map(onOrder.rows.map((r) => [r.variant_id, toScaled(r.qty)]));
    const lines = needs.map((n) => {
      const s = plan.shortages.find((x) => x.variantId === n.variantId);
      const short = s ? toScaled(s.short) : 0n;
      const inc = incoming.get(n.variantId) ?? 0n;
      return {
        variantId: n.variantId,
        required: n.required,
        available: s ? s.available : n.required,
        shortage: fromScaled(short),
        onOrder: fromScaled(inc),
        shortageAfterOnOrder: fromScaled(short > inc ? short - inc : 0n),
      };
    });
    return {
      bomId: q.bomId, locationId: q.locationId, plannedQuantity: planned, lines,
      canRelease: plan.shortages.length === 0,
      fullyCoveredByOnOrder: lines.every((l) => toScaled(l.shortageAfterOnOrder) === 0n),
    };
  });

  // ---- quality holds on lots and rolls ----
  async function authorizeLot(tx: Tx, req: import('fastify').FastifyRequest, perm: 'quality.hold' | 'quality.release', lotId: string) {
    const lot = await tx.query<{ code: string; hold_status: string; held_by: string | null }>(
      'SELECT code, hold_status, held_by FROM stock_lots WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [lotId, req.actor.organizationId],
    );
    if (!lot.rows[0]) throw notFound('Lot');
    const where = await tx.query<{ location_id: string }>('SELECT DISTINCT location_id FROM stock_balances WHERE lot_id = $1 AND (quantity <> 0 OR reserved <> 0)', [lotId]);
    let ok = where.rows.length === 0 ? await can(tx, req.actor, perm, { kind: 'organization' }) : false;
    for (const w of where.rows) if (!ok && (await can(tx, req.actor, perm, { kind: 'location', locationId: w.location_id }))) ok = true;
    if (!ok) throw forbidden();
    return lot.rows[0];
  }

  app.post('/quality/lots/:id/hold', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const lot = await authorizeLot(tx, req, 'quality.hold', id);
      if (lot.hold_status === 'quarantined') throw conflict('Lot is already quarantined');
      await tx.query(
        `UPDATE stock_lots SET hold_status = 'quarantined', hold_reason = $2, held_by = $3, held_at = now(), released_by = NULL, released_at = NULL WHERE id = $1`,
        [id, body.reason, actor.userId],
      );
      await audit(tx, req, 'quality.hold', 'stock_lot', id, { reason: body.reason });
      return { status: 200, body: { id, code: lot.code, holdStatus: 'quarantined', reason: body.reason } };
    });
  });

  app.post('/quality/lots/:id/release', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ note: z.string().trim().min(3).max(500) }).parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const lot = await authorizeLot(tx, req, 'quality.release', id);
      if (lot.hold_status !== 'quarantined') throw conflict('Lot is not on hold');
      if (lot.held_by === actor.userId) throw forbidden('A different person must release a lot you put on hold');
      await tx.query(`UPDATE stock_lots SET hold_status = 'released', released_by = $2, released_at = now() WHERE id = $1`, [id, actor.userId]);
      await audit(tx, req, 'quality.release', 'stock_lot', id, { note: body.note });
      return { status: 200, body: { id, code: lot.code, holdStatus: 'released', note: body.note } };
    });
  });
};
