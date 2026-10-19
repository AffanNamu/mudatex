import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize } from '../auth/authorize.js';
import type { Db, Tx } from '../db.js';
import { fromScaled, normalize, toScaled } from '../domain/decimal.js';
import { conflict, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { audit, checkLot, loadStockLocation, loadVariant, quantityField, resolveQuantity, uuid } from '../inventory/common.js';
import { adjustReserved, postMovements } from '../inventory/ledger.js';

const reserveBody = z.object({
  locationId: uuid,
  variantId: uuid,
  lotId: uuid.optional(),
  quantity: quantityField,
  unitId: uuid.optional(),
  referenceType: z.string().min(1).max(60),
  referenceId: z.string().min(1).max(200),
  expiresAt: z.string().datetime().optional(),
});

const fulfilBody = z.object({
  quantity: quantityField.optional(),
  unitId: uuid.optional(),
  reasonCode: z.enum(['sale', 'shipment', 'production_consumption', 'sample']).default('sale'),
});

interface ReservationRow {
  id: string;
  location_id: string;
  variant_id: string;
  lot_id: string | null;
  quantity: string;
  fulfilled_quantity: string;
  released_quantity: string;
  status: string;
  expires_at: Date | null;
}

const remaining = (r: ReservationRow) => toScaled(r.quantity) - toScaled(r.fulfilled_quantity) - toScaled(r.released_quantity);

async function lockReservation(tx: Tx, organizationId: string, id: string): Promise<ReservationRow> {
  const { rows } = await tx.query<ReservationRow>(
    `SELECT id, location_id, variant_id, lot_id, quantity, fulfilled_quantity, released_quantity, status, expires_at
       FROM stock_reservations WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [id, organizationId],
  );
  if (!rows[0]) throw notFound('Reservation');
  return rows[0];
}

const view = (r: ReservationRow) => ({
  id: r.id,
  locationId: r.location_id,
  variantId: r.variant_id,
  lotId: r.lot_id,
  quantity: normalize(r.quantity),
  fulfilledQuantity: normalize(r.fulfilled_quantity),
  releasedQuantity: normalize(r.released_quantity),
  remaining: fromScaled(remaining(r)),
  status: r.status,
  expiresAt: r.expires_at,
});

export const inventoryReservationRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/inventory/reservations', async (req, reply) => {
    const body = reserveBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      await authorize(tx, actor, 'inventory.reserve', { kind: 'location', locationId: body.locationId });
      const location = await loadStockLocation(tx, actor.organizationId, body.locationId);
      const variant = await loadVariant(tx, actor.organizationId, body.variantId);
      const lotId = await checkLot(tx, actor.organizationId, variant, body.lotId);
      const quantity = await resolveQuantity(tx, variant, body.quantity, body.unitId);

      // The balance CHECK (reserved <= quantity) is what makes concurrent reservations safe.
      await adjustReserved(tx, { locationId: location.id, variantId: variant.id, lotId }, quantity);

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO stock_reservations
           (organization_id, location_id, variant_id, lot_id, quantity, reference_type, reference_id, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [actor.organizationId, location.id, variant.id, lotId, quantity, body.referenceType, body.referenceId, body.expiresAt ?? null, actor.userId],
      );
      const id = rows[0]!.id;
      await audit(tx, req, 'inventory.reserve', 'reservation', id, { ...body, quantity });
      return { status: 201, body: { id, quantity, remaining: quantity, status: 'active' } };
    });
  });

  app.get('/inventory/reservations/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { rows } = await db.query<ReservationRow>(
      `SELECT id, location_id, variant_id, lot_id, quantity, fulfilled_quantity, released_quantity, status, expires_at
         FROM stock_reservations WHERE id = $1 AND organization_id = $2`,
      [id, req.actor.organizationId],
    );
    if (!rows[0]) throw notFound('Reservation');
    await authorize(db, req.actor, 'inventory.read', { kind: 'location', locationId: rows[0].location_id });
    return view(rows[0]);
  });

  app.post('/inventory/reservations/:id/fulfil', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = fulfilBody.parse(req.body ?? {});
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const r = await lockReservation(tx, actor.organizationId, id);
      await authorize(tx, actor, 'inventory.issue', { kind: 'location', locationId: r.location_id });
      if (r.status !== 'active') throw conflict('Reservation is closed');
      if (r.expires_at && r.expires_at <= new Date()) throw conflict('Reservation has expired');

      const variant = await loadVariant(tx, actor.organizationId, r.variant_id);
      const left = remaining(r);
      const quantity = body.quantity ? await resolveQuantity(tx, variant, body.quantity, body.unitId) : fromScaled(left);
      if (toScaled(quantity) > left) throw conflict('Quantity exceeds the reserved remainder');

      const { commandId } = await postMovements(
        tx,
        { organizationId: actor.organizationId, actorUserId: actor.userId, requestId: req.id, reason: body.reasonCode, referenceType: 'reservation', referenceId: id },
        [{ locationId: r.location_id, variantId: r.variant_id, lotId: r.lot_id, state: 'on_hand', delta: `-${quantity}`, reservedDelta: `-${quantity}`, type: 'issue' }],
      );
      const closing = toScaled(quantity) === left;
      await tx.query(
        `UPDATE stock_reservations
            SET fulfilled_quantity = fulfilled_quantity + $2::numeric,
                status = CASE WHEN $3 THEN 'closed' ELSE status END,
                closed_at = CASE WHEN $3 THEN now() ELSE closed_at END
          WHERE id = $1`,
        [id, quantity, closing],
      );
      await audit(tx, req, 'inventory.reservation_fulfil', 'reservation', id, { commandId, quantity });
      return { status: 200, body: { commandId, fulfilled: quantity, remaining: fromScaled(left - toScaled(quantity)), status: closing ? 'closed' : 'active' } };
    });
  });

  app.post('/inventory/reservations/:id/release', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const r = await lockReservation(tx, actor.organizationId, id);
      await authorize(tx, actor, 'inventory.reserve', { kind: 'location', locationId: r.location_id });
      if (r.status !== 'active') throw conflict('Reservation is closed');
      const left = fromScaled(remaining(r));
      await adjustReserved(tx, { locationId: r.location_id, variantId: r.variant_id, lotId: r.lot_id }, `-${left}`);
      await tx.query(
        `UPDATE stock_reservations SET released_quantity = released_quantity + $2::numeric, status = 'closed', closed_at = now() WHERE id = $1`,
        [id, left],
      );
      await audit(tx, req, 'inventory.reservation_release', 'reservation', id, { released: left });
      return { status: 200, body: { released: left, status: 'closed' } };
    });
  });
};
