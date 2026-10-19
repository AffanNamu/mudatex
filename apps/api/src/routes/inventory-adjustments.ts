import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize } from '../auth/authorize.js';
import type { Db, Tx } from '../db.js';
import { normalize } from '../domain/decimal.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { audit, checkLot, loadStockLocation, loadVariant, quantityField, resolveQuantity, uuid } from '../inventory/common.js';
import { postMovements, type Posting } from '../inventory/ledger.js';

const createBody = z.object({
  locationId: uuid,
  reason: z.string().trim().min(5).max(1000),
  lines: z
    .array(
      z.object({
        variantId: uuid,
        lotId: uuid.optional(),
        direction: z.enum(['increase', 'decrease']),
        quantity: quantityField,
        unitId: uuid.optional(),
      }),
    )
    .min(1)
    .max(200),
});
const decisionBody = z.object({ note: z.string().trim().max(1000).optional() }).default({});

interface AdjustmentRow {
  id: string;
  location_id: string;
  reason: string;
  status: string;
  requested_by: string;
}

async function lockAdjustment(tx: Tx, organizationId: string, id: string): Promise<AdjustmentRow> {
  const { rows } = await tx.query<AdjustmentRow>(
    `SELECT id, location_id, reason, status, requested_by FROM stock_adjustments
      WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [id, organizationId],
  );
  if (!rows[0]) throw notFound('Adjustment');
  return rows[0];
}

async function readAdjustment(db: Db | Tx, organizationId: string, id: string) {
  const a = await db.query(
    `SELECT id, location_id AS "locationId", reason, status, requested_by AS "requestedBy", decided_by AS "decidedBy",
            decided_at AS "decidedAt", decision_note AS "decisionNote", created_at AS "createdAt"
       FROM stock_adjustments WHERE id = $1 AND organization_id = $2`,
    [id, organizationId],
  );
  if (!a.rows[0]) throw notFound('Adjustment');
  const lines = await db.query<{ delta: string }>(
    'SELECT id, variant_id AS "variantId", lot_id AS "lotId", delta FROM stock_adjustment_lines WHERE adjustment_id = $1 ORDER BY seq',
    [id],
  );
  return { ...a.rows[0], lines: lines.rows.map((l) => ({ ...l, delta: normalize(l.delta) })) };
}

export const inventoryAdjustmentRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/inventory/adjustments', async (req, reply) => {
    const body = createBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      await authorize(tx, actor, 'inventory.adjust', { kind: 'location', locationId: body.locationId });
      const location = await loadStockLocation(tx, actor.organizationId, body.locationId);
      const a = await tx.query<{ id: string }>(
        'INSERT INTO stock_adjustments (organization_id, location_id, reason, requested_by) VALUES ($1, $2, $3, $4) RETURNING id',
        [actor.organizationId, location.id, body.reason, actor.userId],
      );
      const id = a.rows[0]!.id;
      for (const line of body.lines) {
        const variant = await loadVariant(tx, actor.organizationId, line.variantId);
        const lotId = await checkLot(tx, actor.organizationId, variant, line.lotId, { allowQuarantined: true });
        const quantity = await resolveQuantity(tx, variant, line.quantity, line.unitId);
        await tx.query(
          'INSERT INTO stock_adjustment_lines (adjustment_id, variant_id, lot_id, delta) VALUES ($1, $2, $3, $4)',
          [id, variant.id, lotId, line.direction === 'decrease' ? `-${quantity}` : quantity],
        );
      }
      await audit(tx, req, 'inventory.adjustment_request', 'adjustment', id, { reason: body.reason, lines: body.lines });
      return { status: 201, body: await readAdjustment(tx, actor.organizationId, id) };
    });
  });

  app.get('/inventory/adjustments/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const adjustment = await readAdjustment(db, req.actor.organizationId, id);
    await authorize(db, req.actor, 'inventory.read', { kind: 'location', locationId: adjustment.locationId });
    return adjustment;
  });

  app.post('/inventory/adjustments/:id/approve', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = decisionBody.parse(req.body ?? {});
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const a = await lockAdjustment(tx, actor.organizationId, id);
      await authorize(tx, actor, 'inventory.adjust.approve', { kind: 'location', locationId: a.location_id });
      if (a.requested_by === actor.userId) throw forbidden('You cannot approve your own adjustment');
      if (a.status !== 'pending') throw conflict(`Adjustment is already ${a.status}`);

      const { rows } = await tx.query<{ variant_id: string; lot_id: string | null; delta: string }>(
        'SELECT variant_id, lot_id, delta FROM stock_adjustment_lines WHERE adjustment_id = $1',
        [id],
      );
      const postings: Posting[] = rows.map((l) => ({
        locationId: a.location_id,
        variantId: l.variant_id,
        lotId: l.lot_id,
        state: 'on_hand',
        delta: normalize(l.delta),
        type: 'adjustment',
      }));
      await postMovements(
        tx,
        { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id, reason: a.reason, referenceType: 'adjustment', referenceId: id },
        postings,
      );
      await tx.query(
        `UPDATE stock_adjustments SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`,
        [id, actor.userId, body.note ?? null],
      );
      await audit(tx, req, 'inventory.adjustment_approve', 'adjustment', id);
      return { status: 200, body: await readAdjustment(tx, actor.organizationId, id) };
    });
  });

  app.post('/inventory/adjustments/:id/reject', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ note: z.string().trim().min(3).max(1000) }).parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const a = await lockAdjustment(tx, actor.organizationId, id);
      await authorize(tx, actor, 'inventory.adjust.approve', { kind: 'location', locationId: a.location_id });
      if (a.requested_by === actor.userId) throw forbidden('You cannot decide your own adjustment');
      if (a.status !== 'pending') throw conflict(`Adjustment is already ${a.status}`);
      await tx.query(
        `UPDATE stock_adjustments SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`,
        [id, actor.userId, body.note],
      );
      await audit(tx, req, 'inventory.adjustment_reject', 'adjustment', id, { note: body.note });
      return { status: 200, body: await readAdjustment(tx, actor.organizationId, id) };
    });
  });
};
