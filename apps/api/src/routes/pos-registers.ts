import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize } from '../auth/authorize.js';
import { withTx, type Db, type Tx } from '../db.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { audit, loadStockLocation, uuid } from '../inventory/common.js';

const registerBody = z.object({
  locationId: uuid,
  code: z.string().regex(/^[A-Z0-9]{2,10}$/),
  name: z.string().min(1).max(100),
  priceListId: uuid,
  maxDiscountBps: z.number().int().min(0).max(10000).default(0),
  refundThresholdMinor: z.number().int().min(0).nullable().default(null),
});

const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export async function sessionReport(db: Db | Tx, sessionId: string) {
  const s = await db.query<{ opening: string; register_id: string }>('SELECT opening_float_minor AS opening, register_id FROM pos_sessions WHERE id = $1', [sessionId]);
  if (!s.rows[0]) throw notFound('Session');
  const sales = await db.query<{ method: string; total: string; count: string }>(
    `SELECT p.method, COALESCE(sum(p.amount_minor), 0) AS total, count(DISTINCT p.sale_id) AS count
       FROM pos_payments p JOIN pos_sales s ON s.id = p.sale_id
      WHERE s.session_id = $1 AND p.status = 'confirmed' AND s.status = 'completed' GROUP BY p.method ORDER BY p.method`,
    [sessionId],
  );
  const pending = await db.query<{ count: string }>(`SELECT count(*) FROM pos_sales WHERE session_id = $1 AND status = 'pending_payment'`, [sessionId]);
  const refunds = await db.query<{ method: string; total: string }>(
    `SELECT refund_method AS method, COALESCE(sum(refund_total_minor), 0) AS total FROM pos_returns WHERE session_id = $1 GROUP BY refund_method ORDER BY 1`,
    [sessionId],
  );
  const cashIn = BigInt(sales.rows.find((r) => r.method === 'cash')?.total ?? '0');
  const cashOut = BigInt(refunds.rows.find((r) => r.method === 'cash')?.total ?? '0');
  const expected = BigInt(s.rows[0].opening) + cashIn - cashOut;
  return {
    sessionId,
    openingFloatMinor: Number(s.rows[0].opening),
    salesByMethod: sales.rows.map((r) => ({ method: r.method, totalMinor: Number(r.total), sales: Number(r.count) })),
    refundsByMethod: refunds.rows.map((r) => ({ method: r.method, totalMinor: Number(r.total) })),
    pendingSales: Number(pending.rows[0]!.count),
    expectedCashMinor: Number(expected),
  };
}

export const posRegisterRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/pos/registers', async (req, reply) => {
    const body = registerBody.parse(req.body);
    const { actor } = req;
    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'pos.register.manage', { kind: 'location', locationId: body.locationId });
      const location = await loadStockLocation(tx, actor.organizationId, body.locationId);
      const list = await tx.query('SELECT 1 FROM price_lists WHERE id = $1 AND legal_entity_id = $2', [body.priceListId, location.legalEntityId]);
      if (!list.rowCount) throw invalid('Price list must belong to the register\'s legal entity');
      const { rows } = await tx.query(
        `INSERT INTO pos_registers (organization_id, legal_entity_id, location_id, code, name, price_list_id, max_discount_bps, refund_threshold_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, location_id AS "locationId", code, name, price_list_id AS "priceListId",
                   max_discount_bps AS "maxDiscountBps", refund_threshold_minor AS "refundThresholdMinor"`,
        [actor.organizationId, location.legalEntityId, location.id, body.code, body.name, body.priceListId, body.maxDiscountBps, body.refundThresholdMinor],
      );
      await audit(tx, req, 'pos.register_create', 'pos_register', rows[0].id, rows[0]);
      return rows[0];
    });
    return reply.status(201).send(created);
  });

  app.post('/pos/registers/:id/sessions', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ openingFloatMinor: money }).parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const reg = await tx.query<{ location_id: string; status: string }>('SELECT location_id, status FROM pos_registers WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, actor.organizationId]);
      const r = reg.rows[0];
      if (!r) throw notFound('Register');
      await authorize(tx, actor, 'pos.session', { kind: 'location', locationId: r.location_id });
      if (r.status !== 'active') throw conflict('Register is inactive');
      const open = await tx.query('SELECT 1 FROM pos_sessions WHERE register_id = $1 AND status = \'open\'', [id]);
      if (open.rowCount) throw conflict('This register already has an open session');
      const { rows } = await tx.query(
        `INSERT INTO pos_sessions (organization_id, register_id, cashier_id, opening_float_minor) VALUES ($1, $2, $3, $4)
         RETURNING id, register_id AS "registerId", cashier_id AS "cashierId", opening_float_minor AS "openingFloatMinor", status, opened_at AS "openedAt"`,
        [actor.organizationId, id, actor.userId, body.openingFloatMinor],
      );
      await audit(tx, req, 'pos.session_open', 'pos_session', rows[0].id, rows[0]);
      return { status: 201, body: { ...rows[0], openingFloatMinor: Number(rows[0].openingFloatMinor) } };
    });
  });

  app.get('/pos/sessions/:id/report', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const s = await db.query<{ location_id: string }>(
      `SELECT r.location_id FROM pos_sessions s JOIN pos_registers r ON r.id = s.register_id WHERE s.id = $1 AND s.organization_id = $2`,
      [id, req.actor.organizationId],
    );
    if (!s.rows[0]) throw notFound('Session');
    await authorize(db, req.actor, 'pos.read', { kind: 'location', locationId: s.rows[0].location_id });
    return sessionReport(db, id);
  });

  app.post('/pos/sessions/:id/close', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ countedCashMinor: money, note: z.string().max(1000).optional() }).parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const s = await tx.query<{ status: string; cashier_id: string; location_id: string }>(
        `SELECT s.status, s.cashier_id, r.location_id FROM pos_sessions s JOIN pos_registers r ON r.id = s.register_id
          WHERE s.id = $1 AND s.organization_id = $2 FOR UPDATE OF s`,
        [id, actor.organizationId],
      );
      const row = s.rows[0];
      if (!row) throw notFound('Session');
      await authorize(tx, actor, 'pos.session', { kind: 'location', locationId: row.location_id });
      if (row.cashier_id !== actor.userId) throw forbidden('Only the cashier who opened the session can close it');
      if (row.status !== 'open') throw conflict('Session is already closed');

      const report = await sessionReport(tx, id);
      if (report.pendingSales > 0) throw conflict('Resolve pending-payment sales before closing the session');
      const variance = body.countedCashMinor - report.expectedCashMinor;
      await tx.query(
        `UPDATE pos_sessions SET status = 'closed', closed_at = now(), closed_by = $2, expected_cash_minor = $3,
                counted_cash_minor = $4, variance_minor = $5, close_note = $6 WHERE id = $1`,
        [id, actor.userId, report.expectedCashMinor, body.countedCashMinor, variance, body.note ?? null],
      );
      await audit(tx, req, 'pos.session_close', 'pos_session', id, { expected: report.expectedCashMinor, counted: body.countedCashMinor, variance });
      return { status: 200, body: { ...report, countedCashMinor: body.countedCashMinor, varianceMinor: variance, status: 'closed' } };
    });
  });
};
