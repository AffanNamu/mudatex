import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, can } from '../auth/authorize.js';
import type { Db, Tx } from '../db.js';
import { fromScaled, normalize, toScaled } from '../domain/decimal.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { audit, checkLot, lineBody, loadStockLocation, loadVariant, quantityField, resolveQuantity, uuid } from '../inventory/common.js';
import { postMovements, type Posting } from '../inventory/ledger.js';

const createBody = z.object({
  sourceLocationId: uuid,
  destinationLocationId: uuid,
  reference: z.string().max(200).optional(),
  lines: z.array(lineBody).min(1).max(200),
});

const receiveBody = z.object({
  lines: z.array(z.object({ lineId: uuid, quantity: quantityField, unitId: uuid.optional() })).min(1).max(200),
});

interface TransferRow {
  id: string;
  source_location_id: string;
  destination_location_id: string;
  status: string;
}
interface LineRow {
  id: string;
  variant_id: string;
  lot_id: string | null;
  quantity: string;
  received_quantity: string;
  cancelled_quantity: string;
}

const open = (l: LineRow) => toScaled(l.quantity) - toScaled(l.received_quantity) - toScaled(l.cancelled_quantity);

async function lockTransfer(tx: Tx, organizationId: string, id: string): Promise<TransferRow> {
  const { rows } = await tx.query<TransferRow>(
    `SELECT id, source_location_id, destination_location_id, status FROM stock_transfers
      WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [id, organizationId],
  );
  if (!rows[0]) throw notFound('Transfer');
  return rows[0];
}

async function readTransfer(db: Db | Tx, organizationId: string, id: string) {
  const t = await db.query(
    `SELECT id, source_location_id AS "sourceLocationId", destination_location_id AS "destinationLocationId",
            status, reference, created_at AS "createdAt", closed_at AS "closedAt"
       FROM stock_transfers WHERE id = $1 AND organization_id = $2`,
    [id, organizationId],
  );
  if (!t.rows[0]) throw notFound('Transfer');
  const lines = await db.query<{ quantity: string; receivedQuantity: string; cancelledQuantity: string }>(
    `SELECT id, variant_id AS "variantId", lot_id AS "lotId", quantity, received_quantity AS "receivedQuantity",
            cancelled_quantity AS "cancelledQuantity"
       FROM stock_transfer_lines WHERE transfer_id = $1 ORDER BY id`,
    [id],
  );
  return {
    ...t.rows[0],
    lines: lines.rows.map((l) => ({
      ...l,
      quantity: normalize(l.quantity),
      receivedQuantity: normalize(l.receivedQuantity),
      cancelledQuantity: normalize(l.cancelledQuantity),
    })),
  };
}

async function closeIfDone(tx: Tx, id: string): Promise<'in_transit' | 'completed' | 'cancelled'> {
  const { rows } = await tx.query<LineRow>('SELECT id, variant_id, lot_id, quantity, received_quantity, cancelled_quantity FROM stock_transfer_lines WHERE transfer_id = $1', [id]);
  if (rows.some((l) => open(l) > 0n)) return 'in_transit';
  const anyReceived = rows.some((l) => toScaled(l.received_quantity) > 0n);
  const status = anyReceived ? 'completed' : 'cancelled';
  await tx.query('UPDATE stock_transfers SET status = $2, closed_at = now() WHERE id = $1', [id, status]);
  return status;
}

export const inventoryTransferRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/inventory/transfers', async (req, reply) => {
    const body = createBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      await authorize(tx, actor, 'inventory.transfer', { kind: 'location', locationId: body.sourceLocationId });
      const source = await loadStockLocation(tx, actor.organizationId, body.sourceLocationId);
      const dest = await loadStockLocation(tx, actor.organizationId, body.destinationLocationId);
      if (source.id === dest.id) throw invalid('Source and destination must differ');
      // Transfers between legal entities need intercompany accounting that is not built yet.
      if (source.legalEntityId !== dest.legalEntityId) throw invalid('Intercompany transfers are not supported yet');

      const t = await tx.query<{ id: string }>(
        `INSERT INTO stock_transfers (organization_id, source_location_id, destination_location_id, reference, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [actor.organizationId, source.id, dest.id, body.reference ?? null, actor.userId],
      );
      const id = t.rows[0]!.id;

      const postings: Posting[] = [];
      for (const line of body.lines) {
        const variant = await loadVariant(tx, actor.organizationId, line.variantId);
        const lotId = await checkLot(tx, actor.organizationId, variant, line.lotId);
        const quantity = await resolveQuantity(tx, variant, line.quantity, line.unitId);
        await tx.query(
          'INSERT INTO stock_transfer_lines (transfer_id, variant_id, lot_id, quantity) VALUES ($1, $2, $3, $4)',
          [id, variant.id, lotId, quantity],
        );
        postings.push(
          { locationId: source.id, variantId: variant.id, lotId, state: 'on_hand', delta: `-${quantity}`, type: 'transfer_dispatch' },
          { locationId: dest.id, variantId: variant.id, lotId, state: 'in_transit', delta: quantity, type: 'transfer_dispatch' },
        );
      }
      await postMovements(
        tx,
        { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id, referenceType: 'transfer', referenceId: id },
        postings,
      );
      await audit(tx, req, 'inventory.transfer_dispatch', 'transfer', id, { source: source.id, destination: dest.id, lines: body.lines });
      return { status: 201, body: await readTransfer(tx, actor.organizationId, id) };
    });
  });

  app.get('/inventory/transfers/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const transfer = await readTransfer(db, req.actor.organizationId, id);
    const ok =
      (await can(db, req.actor, 'inventory.read', { kind: 'location', locationId: transfer.sourceLocationId })) ||
      (await can(db, req.actor, 'inventory.read', { kind: 'location', locationId: transfer.destinationLocationId }));
    if (!ok) throw forbidden();
    return transfer;
  });

  app.post('/inventory/transfers/:id/receive', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = receiveBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const t = await lockTransfer(tx, actor.organizationId, id);
      await authorize(tx, actor, 'inventory.receive', { kind: 'location', locationId: t.destination_location_id });
      if (t.status !== 'in_transit') throw conflict(`Transfer is ${t.status}`);

      const postings: Posting[] = [];
      for (const input of body.lines) {
        const { rows } = await tx.query<LineRow>(
          `SELECT id, variant_id, lot_id, quantity, received_quantity, cancelled_quantity
             FROM stock_transfer_lines WHERE id = $1 AND transfer_id = $2 FOR UPDATE`,
          [input.lineId, id],
        );
        const line = rows[0];
        if (!line) throw notFound('Transfer line');
        const variant = await loadVariant(tx, actor.organizationId, line.variant_id);
        const quantity = await resolveQuantity(tx, variant, input.quantity, input.unitId);
        if (toScaled(quantity) > open(line)) throw conflict('Quantity exceeds what is still in transit for this line');

        await tx.query('UPDATE stock_transfer_lines SET received_quantity = received_quantity + $2::numeric WHERE id = $1', [line.id, quantity]);
        postings.push(
          { locationId: t.destination_location_id, variantId: line.variant_id, lotId: line.lot_id, state: 'in_transit', delta: `-${quantity}`, type: 'transfer_receive' },
          { locationId: t.destination_location_id, variantId: line.variant_id, lotId: line.lot_id, state: 'on_hand', delta: quantity, type: 'transfer_receive' },
        );
      }
      await postMovements(
        tx,
        { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id, referenceType: 'transfer', referenceId: id },
        postings,
      );
      await closeIfDone(tx, id);
      await audit(tx, req, 'inventory.transfer_receive', 'transfer', id, { lines: body.lines });
      return { status: 200, body: await readTransfer(tx, actor.organizationId, id) };
    });
  });

  // Returns whatever is still in transit to the source location.
  app.post('/inventory/transfers/:id/cancel', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const t = await lockTransfer(tx, actor.organizationId, id);
      await authorize(tx, actor, 'inventory.transfer', { kind: 'location', locationId: t.source_location_id });
      if (t.status !== 'in_transit') throw conflict(`Transfer is ${t.status}`);

      const { rows } = await tx.query<LineRow>(
        `SELECT id, variant_id, lot_id, quantity, received_quantity, cancelled_quantity
           FROM stock_transfer_lines WHERE transfer_id = $1 FOR UPDATE`,
        [id],
      );
      const postings: Posting[] = [];
      for (const line of rows) {
        const left = open(line);
        if (left <= 0n) continue;
        const quantity = fromScaled(left);
        await tx.query('UPDATE stock_transfer_lines SET cancelled_quantity = cancelled_quantity + $2::numeric WHERE id = $1', [line.id, quantity]);
        postings.push(
          { locationId: t.destination_location_id, variantId: line.variant_id, lotId: line.lot_id, state: 'in_transit', delta: `-${quantity}`, type: 'transfer_cancel' },
          { locationId: t.source_location_id, variantId: line.variant_id, lotId: line.lot_id, state: 'on_hand', delta: quantity, type: 'transfer_cancel' },
        );
      }
      await postMovements(
        tx,
        { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id, referenceType: 'transfer', referenceId: id },
        postings,
      );
      await closeIfDone(tx, id);
      await audit(tx, req, 'inventory.transfer_cancel', 'transfer', id);
      return { status: 200, body: await readTransfer(tx, actor.organizationId, id) };
    });
  });
};
