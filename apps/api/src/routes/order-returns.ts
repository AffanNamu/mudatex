import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, grantsFor } from '../auth/authorize.js';
import type { Db } from '../db.js';
import { normalize } from '../domain/decimal.js';
import { notFound } from '../errors.js';
import { uuid } from '../inventory/common.js';
import { decideReturn, receiveReturn } from '../shop/returns.js';
import { listReturns } from '../shop/returns-read.js';

/** The returns desk for online orders: buyers ask in the shop, staff decide here, book the goods in and put them back on the shelf. */
export const orderReturnRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  async function entityOf(returnId: string, organizationId: string) {
    const { rows } = await db.query<{ legal_entity_id: string; order_id: string }>(
      `SELECT o.legal_entity_id, o.id AS order_id FROM order_returns r JOIN sales_orders o ON o.id = r.order_id WHERE r.id = $1 AND r.organization_id = $2`, [returnId, organizationId]);
    if (!rows[0]) throw notFound('Return');
    return rows[0];
  }

  app.get('/order-returns', async (req) => {
    const q = z.object({ status: z.enum(['requested', 'approved', 'rejected', 'received', 'cancelled']).optional() }).parse(req.query);
    const grants = await grantsFor(db, req.actor, 'orders.refund');
    const { rows } = await db.query(
      `SELECT r.id, r.status, r.reason, r.note, r.decision_note AS "decisionNote", r.refund_minor::float8 AS "refundMinor", r.created_at AS "createdAt",
              o.id AS "orderId", o.order_no AS "orderNo", o.currency, cu.minor_unit AS "minorUnit", o.contact->>'name' AS "customerName",
              o.legal_entity_id AS "legalEntityId", e.country_code AS "countryCode",
              (SELECT json_agg(json_build_object('lineNo', l.line_no, 'quantity', l.quantity::text, 'title', ol.title, 'sku', ol.sku, 'restocked', l.restocked) ORDER BY l.line_no)
                 FROM order_return_lines l JOIN sales_order_lines ol ON ol.order_id = r.order_id AND ol.line_no = l.line_no WHERE l.return_id = r.id) AS lines
         FROM order_returns r JOIN sales_orders o ON o.id = r.order_id JOIN legal_entities e ON e.id = o.legal_entity_id JOIN currencies cu ON cu.code = o.currency
        WHERE r.organization_id = $1 AND ($2::text IS NULL OR r.status = $2) ORDER BY r.created_at DESC LIMIT 200`,
      [req.actor.organizationId, q.status ?? null]);
    return rows.filter((r) => grants.group || grants.countries.has(r.countryCode.trim()) || grants.legalEntities.has(r.legalEntityId)).map(({ countryCode: _c, legalEntityId: _l, ...r }) => ({ ...r, lines: (r.lines ?? []).map((l: { quantity: string }) => ({ ...l, quantity: normalize(l.quantity) })) }));
  });

  app.get('/sales-orders/:id/returns', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const o = await db.query<{ legal_entity_id: string }>('SELECT legal_entity_id FROM sales_orders WHERE id = $1 AND organization_id = $2', [id, req.actor.organizationId]);
    if (!o.rows[0]) throw notFound('Order');
    await authorize(db, req.actor, 'orders.read', { kind: 'legal_entity', legalEntityId: o.rows[0].legal_entity_id });
    return listReturns(db, id);
  });

  app.post('/order-returns/:id/decision', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().min(1).max(500).optional() }).parse(req.body);
    await authorize(db, req.actor, 'orders.refund', { kind: 'legal_entity', legalEntityId: (await entityOf(id, req.actor.organizationId)).legal_entity_id });
    return decideReturn(db, req.actor.organizationId, id, req.actor.userId, body.decision, body.note, req.id);
  });

  app.post('/order-returns/:id/received', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ locationId: uuid, restockLines: z.array(z.number().int().min(1)).max(50).default([]) }).parse(req.body);
    await authorize(db, req.actor, 'orders.fulfil', { kind: 'legal_entity', legalEntityId: (await entityOf(id, req.actor.organizationId)).legal_entity_id });
    await receiveReturn(db, req.actor.organizationId, id, req.actor.userId, body, req.id);
    return { ok: true };
  });
};
