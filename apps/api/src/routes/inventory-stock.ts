import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, grantsFor } from '../auth/authorize.js';
import type { Db } from '../db.js';
import { fromScaled, normalize, sum, toScaled } from '../domain/decimal.js';
import { conflict, invalid, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import {
  audit,
  checkLot,
  lineBody,
  loadStockLocation,
  loadVariant,
  quantityField,
  resolveQuantity,
  scopeFilter,
  uuid,
} from '../inventory/common.js';
import { postMovements, type Posting } from '../inventory/ledger.js';
import { resolveReceiptLot } from '../inventory/service.js';

const receiptBody = z.object({
  locationId: uuid,
  reference: z.string().max(200).optional(),
  lines: z
    .array(
      z.object({
        variantId: uuid,
        quantity: quantityField,
        unitId: uuid.optional(),
        lotCode: z.string().min(1).max(100).optional(),
      }),
    )
    .min(1)
    .max(200),
});

const issueBody = z.object({
  locationId: uuid,
  reasonCode: z.enum(['sale', 'shipment', 'production_consumption', 'sample']),
  reference: z.string().max(200).optional(),
  lines: z.array(lineBody).min(1).max(200),
});

const splitBody = z.object({
  locationId: uuid,
  children: z.array(z.object({ code: z.string().min(1).max(100), quantity: quantityField, unitId: uuid.optional() })).min(1).max(50),
});

export const inventoryStockRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/inventory/receipts', async (req, reply) => {
    const body = receiptBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      await authorize(tx, actor, 'inventory.receive', { kind: 'location', locationId: body.locationId });
      const location = await loadStockLocation(tx, actor.organizationId, body.locationId);

      const postings: Posting[] = [];
      const lines: { variantId: string; lotId: string | null; quantity: string }[] = [];
      for (const line of body.lines) {
        const variant = await loadVariant(tx, actor.organizationId, line.variantId);
        const quantity = await resolveQuantity(tx, variant, line.quantity, line.unitId);

        const lotId = await resolveReceiptLot(tx, actor.organizationId, variant, line.lotCode, quantity);
        postings.push({ locationId: location.id, variantId: variant.id, lotId, state: 'on_hand', delta: quantity, type: 'receipt' });
        lines.push({ variantId: variant.id, lotId, quantity });
      }

      const { commandId } = await postMovements(
        tx,
        { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id, referenceType: 'receipt', reason: body.reference },
        postings,
      );
      await audit(tx, req, 'inventory.receipt', 'stock_command', commandId, { locationId: location.id, lines });
      return { status: 201, body: { commandId, lines } };
    });
  });

  app.post('/inventory/issues', async (req, reply) => {
    const body = issueBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      await authorize(tx, actor, 'inventory.issue', { kind: 'location', locationId: body.locationId });
      const location = await loadStockLocation(tx, actor.organizationId, body.locationId);

      const postings: Posting[] = [];
      for (const line of body.lines) {
        const variant = await loadVariant(tx, actor.organizationId, line.variantId);
        const lotId = await checkLot(tx, actor.organizationId, variant, line.lotId);
        const quantity = await resolveQuantity(tx, variant, line.quantity, line.unitId);
        postings.push({ locationId: location.id, variantId: variant.id, lotId, state: 'on_hand', delta: `-${quantity}`, type: 'issue' });
      }
      const { commandId } = await postMovements(
        tx,
        { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id, reason: body.reasonCode, referenceType: 'issue', referenceId: body.reference },
        postings,
      );
      await audit(tx, req, 'inventory.issue', 'stock_command', commandId, { locationId: location.id, reasonCode: body.reasonCode, postings });
      return { status: 201, body: { commandId } };
    });
  });

  // Splitting a roll conserves quantity: the parent loses exactly what the children gain.
  app.post('/inventory/rolls/:lotId/split', async (req, reply) => {
    const { lotId } = z.object({ lotId: uuid }).parse(req.params);
    const body = splitBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      await authorize(tx, actor, 'inventory.split', { kind: 'location', locationId: body.locationId });
      const location = await loadStockLocation(tx, actor.organizationId, body.locationId);

      const parent = await tx.query<{ variant_id: string; kind: string }>(
        'SELECT variant_id, kind FROM stock_lots WHERE id = $1 AND organization_id = $2',
        [lotId, actor.organizationId],
      );
      const p = parent.rows[0];
      if (!p) throw notFound('Roll');
      if (p.kind !== 'roll') throw invalid('Only rolls can be split');
      const variant = await loadVariant(tx, actor.organizationId, p.variant_id);

      const codes = body.children.map((c) => c.code);
      if (new Set(codes).size !== codes.length) throw invalid('Duplicate child roll code');

      const quantities = await Promise.all(body.children.map((c) => resolveQuantity(tx, variant, c.quantity, c.unitId)));
      const total = sum(quantities);

      const postings: Posting[] = [
        { locationId: location.id, variantId: variant.id, lotId, state: 'on_hand', delta: `-${total}`, type: 'roll_split' },
      ];
      const children: { lotId: string; code: string; quantity: string }[] = [];
      for (const [i, child] of body.children.entries()) {
        const created = await tx.query<{ id: string }>(
          `INSERT INTO stock_lots (organization_id, variant_id, kind, code, parent_lot_id, initial_quantity)
           VALUES ($1, $2, 'roll', $3, $4, $5) RETURNING id`,
          [actor.organizationId, variant.id, child.code, lotId, quantities[i]],
        );
        const childId = created.rows[0]!.id;
        postings.push({ locationId: location.id, variantId: variant.id, lotId: childId, state: 'on_hand', delta: quantities[i]!, type: 'roll_split' });
        children.push({ lotId: childId, code: child.code, quantity: quantities[i]! });
      }
      const { commandId } = await postMovements(
        tx,
        { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id, referenceType: 'roll_split', referenceId: lotId },
        postings,
      );
      await audit(tx, req, 'inventory.roll_split', 'stock_lot', lotId, { commandId, total, children });
      return { status: 201, body: { commandId, parentLotId: lotId, total, children } };
    });
  });

  app.get('/inventory/balances', async (req) => {
    const q = z.object({ locationId: uuid.optional(), variantId: uuid.optional(), state: z.enum(['on_hand', 'in_transit']).optional() }).parse(req.query);
    const grants = await grantsFor(db, req.actor, 'inventory.read');
    const scope = scopeFilter(grants, 5);
    const { rows } = await db.query<{ locationId: string; variantId: string; lotId: string | null; state: string; quantity: string; reserved: string }>(
      `SELECT b.location_id AS "locationId", b.variant_id AS "variantId", b.lot_id AS "lotId", b.state, b.quantity, b.reserved
         FROM stock_balances b JOIN locations l ON l.id = b.location_id
        WHERE b.organization_id = $1 AND (b.quantity <> 0 OR b.reserved <> 0)
          AND ($2::uuid IS NULL OR b.location_id = $2) AND ($3::uuid IS NULL OR b.variant_id = $3)
          AND ($4::stock_state IS NULL OR b.state = $4) AND ${scope.clause}
        ORDER BY b.location_id, b.variant_id, b.lot_id NULLS FIRST, b.state`,
      [req.actor.organizationId, q.locationId ?? null, q.variantId ?? null, q.state ?? null, ...scope.params],
    );
    return rows.map((r) => ({
      ...r,
      quantity: normalize(r.quantity),
      reserved: normalize(r.reserved),
      available: fromScaled(toScaled(r.quantity) - toScaled(r.reserved)),
    }));
  });

  app.get('/inventory/movements', async (req) => {
    const q = z
      .object({
        locationId: uuid.optional(),
        variantId: uuid.optional(),
        referenceType: z.string().optional(),
        referenceId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    const grants = await grantsFor(db, req.actor, 'inventory.read');
    const scope = scopeFilter(grants, 7);
    const { rows } = await db.query<{ quantity: string }>(
      `SELECT m.id, m.command_id AS "commandId", m.movement_type AS "type", m.location_id AS "locationId",
              m.variant_id AS "variantId", m.lot_id AS "lotId", m.state, m.quantity, m.reason,
              m.reference_type AS "referenceType", m.reference_id AS "referenceId",
              m.actor_user_id AS "actorUserId", m.occurred_at AS "occurredAt"
         FROM stock_movements m JOIN locations l ON l.id = m.location_id
        WHERE m.organization_id = $1
          AND ($2::uuid IS NULL OR m.location_id = $2) AND ($3::uuid IS NULL OR m.variant_id = $3)
          AND ($4::text IS NULL OR m.reference_type = $4) AND ($5::text IS NULL OR m.reference_id = $5)
          AND ${scope.clause}
        ORDER BY m.id DESC LIMIT $6`,
      [req.actor.organizationId, q.locationId ?? null, q.variantId ?? null, q.referenceType ?? null, q.referenceId ?? null, q.limit, ...scope.params],
    );
    return rows.map((m) => ({ ...m, quantity: normalize(m.quantity) }));
  });

  app.get('/inventory/lots', async (req) => {
    const q = z.object({ variantId: uuid.optional() }).parse(req.query);
    const { rows } = await db.query(
      `SELECT id, variant_id AS "variantId", kind, code, parent_lot_id AS "parentLotId", initial_quantity AS "initialQuantity"
         FROM stock_lots WHERE organization_id = $1 AND ($2::uuid IS NULL OR variant_id = $2) ORDER BY created_at, code`,
      [req.actor.organizationId, q.variantId ?? null],
    );
    return rows.map((r) => ({ ...r, initialQuantity: normalize(r.initialQuantity) }));
  });

  // Rebuilds each balance from the ledger and reports any row that disagrees with the projection.
  app.get('/inventory/reconciliation', async (req) => {
    await authorize(db, req.actor, 'inventory.read', { kind: 'organization' });
    const { rows } = await db.query(
      `WITH ledger AS (
         SELECT location_id, variant_id, COALESCE(lot_id, '00000000-0000-0000-0000-000000000000'::uuid) AS lot_key, state, sum(quantity) AS qty
           FROM stock_movements WHERE organization_id = $1 GROUP BY 1, 2, 3, 4
       ), proj AS (
         SELECT location_id, variant_id, lot_key, state, quantity AS qty FROM stock_balances WHERE organization_id = $1
       )
       SELECT COALESCE(p.location_id, l.location_id) AS "locationId", COALESCE(p.variant_id, l.variant_id) AS "variantId",
              COALESCE(p.state, l.state) AS state, COALESCE(p.qty, 0) AS balance, COALESCE(l.qty, 0) AS ledger
         FROM proj p FULL JOIN ledger l USING (location_id, variant_id, lot_key, state)
        WHERE COALESCE(p.qty, 0) <> COALESCE(l.qty, 0)`,
      [req.actor.organizationId],
    );
    return { consistent: rows.length === 0, discrepancies: rows };
  });
};
