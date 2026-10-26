import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, grantsFor } from '../auth/authorize.js';
import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import { uuid } from '../inventory/common.js';
import type { PaymentProvider } from '../payments/paystack.js';
import { advanceOrder, cancelOrder, readOrder, recordPayment } from '../shop/orders.js';
import { confirmRefundPaid, decideRefund, listRefunds, requestRefund } from '../shop/refunds.js';

const listQuery = z.object({
  status: z.enum(['pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'expired']).optional(),
  q: z.string().trim().min(1).max(80).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const paymentBody = z.object({
  method: z.enum(['card', 'bank_transfer']),
  reference: z.string().trim().min(4).max(100),
  amountMinor: z.number().int().positive(),
});

const stepBody = z.object({
  action: z.enum(['process', 'ship', 'deliver']),
  carrier: z.string().trim().min(1).max(80).optional(),
  trackingRef: z.string().trim().min(1).max(100).optional(),
  note: z.string().trim().max(500).optional(),
});

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// These commands are safe to retry without an Idempotency-Key: each is guarded by the order's state, and a payment
// reference can settle only one order.
/** The order desk: staff view, confirm payment for, fulfil and cancel online orders. */
export const salesOrderRoutes: FastifyPluginAsync<{ db: Db; payments?: PaymentProvider }> = async (app, { db, payments }) => {
  async function entityOf(orderId: string, organizationId: string): Promise<string> {
    const { rows } = await db.query<{ legal_entity_id: string }>('SELECT legal_entity_id FROM sales_orders WHERE id = $1 AND organization_id = $2', [orderId, organizationId]);
    if (!rows[0]) throw notFound('Order');
    return rows[0].legal_entity_id;
  }

  app.get('/sales-orders', async (req) => {
    const q = listQuery.parse(req.query);
    const grants = await grantsFor(db, req.actor, 'orders.read');
    const params: unknown[] = [req.actor.organizationId];
    const where = ['o.organization_id = $1'];
    if (q.status) where.push(`o.status = $${params.push(q.status)}`);
    if (q.q) {
      const like = `$${params.push(`%${escapeLike(q.q)}%`)}`;
      where.push(`(o.order_no ILIKE ${like} OR o.contact->>'email' ILIKE ${like} OR o.contact->>'name' ILIKE ${like} OR o.contact->>'phone' ILIKE ${like})`);
    }
    const { rows } = await db.query(
      `SELECT o.id, o.order_no AS "orderNo", o.status, o.currency, o.total_minor AS "totalMinor", o.paid_minor AS "paidMinor",
              o.payment_method AS "paymentMethod", o.contact->>'name' AS "customerName", o.placed_at AS "placedAt",
              o.legal_entity_id AS "legalEntityId", e.country_code AS "countryCode", cu.minor_unit AS "minorUnit"
         FROM sales_orders o JOIN legal_entities e ON e.id = o.legal_entity_id JOIN currencies cu ON cu.code = o.currency
        WHERE ${where.join(' AND ')} ORDER BY o.placed_at DESC`,
      params,
    );
    const visible = rows.filter((r) => grants.group || grants.countries.has(r.countryCode.trim()) || grants.legalEntities.has(r.legalEntityId));
    const start = (q.page - 1) * q.limit;
    return {
      page: q.page,
      limit: q.limit,
      total: visible.length,
      items: visible.slice(start, start + q.limit).map(({ countryCode: _c, legalEntityId: _l, ...r }) => ({ ...r, totalMinor: Number(r.totalMinor), paidMinor: Number(r.paidMinor) })),
    };
  });

  app.get('/sales-orders/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await authorize(db, req.actor, 'orders.read', { kind: 'legal_entity', legalEntityId: await entityOf(id, req.actor.organizationId) });
    const order = await readOrder(db, { id, organizationId: req.actor.organizationId }, true);
    return { ...order, refunds: await listRefunds(db, id) };
  });

  app.post('/sales-orders/:id/payments', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = paymentBody.parse(req.body);
    const { actor } = req;
    await authorize(db, actor, 'orders.payment.record', { kind: 'legal_entity', legalEntityId: await entityOf(id, actor.organizationId) });
    return await recordPayment(db, actor.organizationId, id, body, { type: 'staff', id: actor.userId }, req.id);
  });

  app.post('/sales-orders/:id/steps', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = stepBody.parse(req.body);
    const { actor } = req;
    await authorize(db, actor, 'orders.fulfil', { kind: 'legal_entity', legalEntityId: await entityOf(id, actor.organizationId) });
    return await advanceOrder(db, actor.organizationId, id, body.action, body, { type: 'staff', id: actor.userId }, req.id);
  });

  app.post('/sales-orders/:id/cancel', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    const { actor } = req;
    await authorize(db, actor, 'orders.cancel', { kind: 'legal_entity', legalEntityId: await entityOf(id, actor.organizationId) });
    return await cancelOrder(db, actor.organizationId, { id }, { type: 'staff', id: actor.userId }, body.reason, req.id);
  });

  // ---- refunds: one person asks, another approves, then the money goes back
  app.post('/sales-orders/:id/refunds', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({
      amountMinor: z.number().int().positive(),
      reason: z.string().trim().min(5).max(500),
      method: z.enum(['card', 'bank_transfer']).optional(),
    }).parse(req.body);
    const { actor } = req;
    await authorize(db, actor, 'orders.refund', { kind: 'legal_entity', legalEntityId: await entityOf(id, actor.organizationId) });
    const refundId = await requestRefund(db, actor.organizationId, id, actor.userId, body, req.id);
    return reply.status(201).send((await listRefunds(db, id)).find((r: any) => r.id === refundId));
  });

  async function refundEntity(refundId: string, organizationId: string) {
    const { rows } = await db.query<{ legal_entity_id: string; order_id: string }>(
      `SELECT o.legal_entity_id, o.id AS order_id FROM order_refunds r JOIN sales_orders o ON o.id = r.order_id WHERE r.id = $1 AND r.organization_id = $2`,
      [refundId, organizationId],
    );
    if (!rows[0]) throw notFound('Refund');
    return rows[0];
  }

  app.post('/refunds/:id/decision', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional() }).parse(req.body);
    const { actor } = req;
    const r = await refundEntity(id, actor.organizationId);
    await authorize(db, actor, 'orders.refund.approve', { kind: 'legal_entity', legalEntityId: r.legal_entity_id });
    await decideRefund(db, payments, actor.organizationId, id, actor.userId, body.decision, body.note, req.id);
    return (await listRefunds(db, r.order_id)).find((x: any) => x.id === id);
  });

  app.post('/refunds/:id/paid', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ payoutRef: z.string().trim().min(4).max(100) }).parse(req.body);
    const { actor } = req;
    const r = await refundEntity(id, actor.organizationId);
    await authorize(db, actor, 'orders.refund.approve', { kind: 'legal_entity', legalEntityId: r.legal_entity_id });
    await confirmRefundPaid(db, actor.organizationId, id, actor.userId, body.payoutRef, req.id);
    return (await listRefunds(db, r.order_id)).find((x: any) => x.id === id);
  });
};
