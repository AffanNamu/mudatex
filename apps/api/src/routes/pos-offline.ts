import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, can, grantsFor } from '../auth/authorize.js';
import { withTx, type Db } from '../db.js';
import { notFound } from '../errors.js';
import { audit, quantityField, scopeFilter, uuid } from '../inventory/common.js';
import { PACK_MAX_AGE_HOURS, packVersion, recordOfflineSale } from '../pos/offline.js';

const saleBody = z.object({
  clientSaleId: z.string().uuid(),
  registerId: uuid,
  sessionId: uuid,
  soldAt: z.string().datetime(),
  deviceId: z.string().max(100).optional(),
  localReceiptNo: z.string().min(1).max(60),
  lines: z.array(z.object({
    variantId: uuid,
    quantity: quantityField,
    discount: z.object({ type: z.literal('percent'), basisPoints: z.number().int().min(1).max(10000) }).optional(),
  })).min(1).max(100),
  tillTotalMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tenderedMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/** Selling without a connection: a pack to take away, and a place to send the sales when the line returns (ADR 002). */
export const posOfflineRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/pos/registers/:id/offline-pack', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    const reg = await db.query<{ id: string; code: string; name: string; location_id: string; price_list_id: string; max_discount_bps: number; currency: string; minor_unit: number }>(
      `SELECT r.id, r.code, r.name, r.location_id, r.price_list_id, r.max_discount_bps, pl.currency, c.minor_unit
         FROM pos_registers r JOIN price_lists pl ON pl.id = r.price_list_id JOIN currencies c ON c.code = pl.currency WHERE r.id = $1 AND r.organization_id = $2`,
      [id, actor.organizationId],
    );
    const r = reg.rows[0];
    if (!r) throw notFound('Register');
    const target = { kind: 'location', locationId: r.location_id } as const;
    await authorize(db, actor, 'pos.sell', target);
    // A pack is made for the person who opened the session, so it cannot be used for someone else's drawer.
    const session = await db.query<{ id: string; opened_at: Date }>(`SELECT id, opened_at FROM pos_sessions WHERE register_id = $1 AND status = 'open' AND cashier_id = $2`, [id, actor.userId]);
    const items = await db.query(
      `SELECT v.id AS "variantId", v.sku, p.name, u.code AS unit, u.precision, u.kind AS "unitKind",
              i.unit_price::text AS "unitPrice", t.code AS "taxCode", t.rate::text AS "taxRate", COALESCE(t.price_inclusive, false) AS "taxInclusive",
              COALESCE((SELECT sum(b.quantity - b.reserved) FROM stock_balances b WHERE b.variant_id = v.id AND b.location_id = $2 AND b.state = 'on_hand' AND b.lot_id IS NULL), 0)::text AS "available",
              COALESCE((SELECT array_agg(bc.barcode) FROM variant_barcodes bc WHERE bc.variant_id = v.id), '{}') AS barcodes
         FROM product_variants v JOIN products p ON p.id = v.product_id JOIN units u ON u.id = p.base_unit_id
         JOIN price_list_items i ON i.variant_id = v.id AND i.price_list_id = $3 AND i.effective_from <= now() AND (i.effective_to IS NULL OR i.effective_to > now())
         LEFT JOIN tax_codes t ON t.id = i.tax_code_id
        WHERE v.organization_id = $1 AND v.status = 'active' AND p.status = 'active' AND v.tracking = 'none'
        ORDER BY p.name, v.sku LIMIT 20000`,
      [actor.organizationId, r.location_id, r.price_list_id],
    );
    const body = {
      register: { id: r.id, code: r.code, name: r.name },
      session: session.rows[0] ? { id: session.rows[0].id, openedAt: session.rows[0].opened_at } : null,
      currency: r.currency.trim(),
      minorUnit: r.minor_unit,
      rules: { maxDiscountBps: r.max_discount_bps, mayDiscount: await can(db, actor, 'pos.discount', target), mayOverride: await can(db, actor, 'pos.discount.override', target) },
      items: items.rows,
    };
    return { ...body, version: packVersion(body), generatedAt: new Date().toISOString(), validHours: PACK_MAX_AGE_HOURS };
  });

  app.post('/pos/offline-sales', async (req) => {
    const body = z.object({ sales: z.array(saleBody).min(1).max(50) }).parse(req.body);
    const { actor } = req;
    // In the order they were made, so receipt numbers follow the order of selling.
    const ordered = [...body.sales].sort((a, b) => a.soldAt.localeCompare(b.soldAt));
    const results = [];
    for (const sale of ordered) results.push(await recordOfflineSale(db, actor, sale, req.id));
    return { results };
  });

  app.get('/pos/offline-exceptions', async (req) => {
    const q = z.object({ status: z.enum(['open', 'resolved']).default('open') }).parse(req.query);
    const grants = await grantsFor(db, req.actor, 'inventory.adjust');
    const scope = scopeFilter(grants, 3);
    const { rows } = await db.query(
      `SELECT x.id, x.quantity_short AS "quantityShort", x.status, x.note, x.created_at AS "createdAt", v.sku, p.name AS "productName", l.name AS "locationName",
              s.receipt_number AS "receiptNumber", s.offline_receipt_no AS "offlineReceiptNo", s.sold_at AS "soldAt"
         FROM pos_offline_exceptions x JOIN pos_sales s ON s.id = x.sale_id JOIN locations l ON l.id = x.location_id
         JOIN product_variants v ON v.id = x.variant_id JOIN products p ON p.id = v.product_id
        WHERE x.organization_id = $1 AND x.status = $2 AND ${scope.clause} ORDER BY x.created_at DESC LIMIT 200`,
      [req.actor.organizationId, q.status, ...scope.params],
    );
    return rows.map((r) => ({ ...r, quantityShort: String(Number(r.quantityShort)) }));
  });

  app.post('/pos/offline-exceptions/:id/resolve', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ note: z.string().trim().min(5).max(500) }).parse(req.body);
    return withTx(db, async (tx) => {
      const found = await tx.query<{ location_id: string; status: string }>('SELECT location_id, status FROM pos_offline_exceptions WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, req.actor.organizationId]);
      if (!found.rows[0]) throw notFound('Exception');
      await authorize(tx, req.actor, 'inventory.adjust', { kind: 'location', locationId: found.rows[0].location_id });
      await tx.query(`UPDATE pos_offline_exceptions SET status = 'resolved', resolved_by = $2, resolved_at = now(), note = $3 WHERE id = $1`, [id, req.actor.userId, body.note]);
      await audit(tx, req, 'pos.offline_exception_resolve', 'pos_offline_exception', id, body);
      return { id, status: 'resolved' };
    });
  });
};
