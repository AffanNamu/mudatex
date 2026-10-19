import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize } from '../auth/authorize.js';
import type { Db } from '../db.js';
import { normalize } from '../domain/decimal.js';
import { notFound } from '../errors.js';
import { uuid } from '../inventory/common.js';

type Q = Db;

async function lineage(db: Q, orgId: string, lotIds: string[], dir: 'up' | 'down'): Promise<{ id: string; code: string }[]> {
  if (!lotIds.length) return [];
  const step = dir === 'up' ? 'JOIN stock_lots l ON l.id = t.parent_lot_id' : 'JOIN stock_lots l ON l.parent_lot_id = t.id';
  const { rows } = await db.query<{ id: string; code: string }>(
    `WITH RECURSIVE t(id, code, parent_lot_id) AS (
       SELECT id, code, parent_lot_id FROM stock_lots WHERE organization_id = $1 AND id = ANY($2::uuid[])
       UNION
       SELECT l.id, l.code, l.parent_lot_id FROM t ${step} WHERE l.organization_id = $1
     ) SELECT id, code FROM t WHERE NOT (id = ANY($2::uuid[]))`,
    [orgId, lotIds],
  );
  return rows;
}

export const manufacturingTraceRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  // Traceability crosses locations, so it needs an organization-wide read grant.
  app.get('/manufacturing/genealogy', async (req) => {
    const q = z.object({ lotId: uuid, direction: z.enum(['backward', 'forward']) }).parse(req.query);
    const orgId = req.actor.organizationId;
    await authorize(db, req.actor, 'manufacturing.read', { kind: 'organization' });
    const start = await db.query<{ id: string; code: string; variant_id: string; kind: string; hold_status: string }>(
      'SELECT id, code, variant_id, kind, hold_status FROM stock_lots WHERE id = $1 AND organization_id = $2',
      [q.lotId, orgId],
    );
    if (!start.rows[0]) throw notFound('Lot');

    const visited = new Set<string>([q.lotId]);
    let frontier = [q.lotId];
    const orders: unknown[] = [];

    for (let depth = 1; depth <= 10 && frontier.length; depth++) {
      // Roll splits: a lot is also its ancestors (going back) or its descendants (going forward).
      const related = await lineage(db, orgId, frontier, q.direction === 'backward' ? 'up' : 'down');
      const lots = [...frontier, ...related.map((r) => r.id)];
      for (const r of related) visited.add(r.id);

      if (q.direction === 'backward') {
        const wos = await db.query<{ id: string; wo_number: string; status: string; bom_id: string }>(
          `SELECT DISTINCT w.id, w.wo_number, w.status, w.bom_id FROM work_order_outputs o JOIN work_orders w ON w.id = o.work_order_id
            WHERE w.organization_id = $1 AND o.lot_id = ANY($2::uuid[]) ORDER BY w.wo_number`,
          [orgId, lots],
        );
        const next: string[] = [];
        for (const w of wos.rows) {
          const used = await db.query<{ lot_id: string; code: string; variant_id: string; net: string }>(
            `SELECT m.lot_id, l.code, c.variant_id, sum(CASE m.kind WHEN 'issue' THEN m.quantity ELSE -m.quantity END) AS net
               FROM work_order_material_moves m JOIN work_order_components c ON c.id = m.component_id LEFT JOIN stock_lots l ON l.id = m.lot_id
              WHERE m.work_order_id = $1 GROUP BY m.lot_id, l.code, c.variant_id HAVING sum(CASE m.kind WHEN 'issue' THEN m.quantity ELSE -m.quantity END) > 0
              ORDER BY c.variant_id, l.code`,
            [w.id],
          );
          const ops = await db.query('SELECT op_no AS "opNo", name, status, completed_at AS "completedAt", completed_by AS "completedBy" FROM work_order_operations WHERE work_order_id = $1 ORDER BY op_no', [w.id]);
          orders.push({
            depth, workOrderId: w.id, woNumber: w.wo_number, status: w.status, operations: ops.rows,
            consumed: used.rows.map((u) => ({ variantId: u.variant_id, lotId: u.lot_id, lotCode: u.code, netQuantity: normalize(u.net) })),
          });
          for (const u of used.rows) if (u.lot_id && !visited.has(u.lot_id)) { visited.add(u.lot_id); next.push(u.lot_id); }
        }
        frontier = next;
      } else {
        const wos = await db.query<{ id: string; wo_number: string; status: string }>(
          `SELECT DISTINCT w.id, w.wo_number, w.status FROM work_order_material_moves m JOIN work_orders w ON w.id = m.work_order_id
            WHERE w.organization_id = $1 AND m.kind = 'issue' AND m.lot_id = ANY($2::uuid[]) ORDER BY w.wo_number`,
          [orgId, lots],
        );
        const next: string[] = [];
        for (const w of wos.rows) {
          const outs = await db.query<{ lot_id: string | null; code: string | null; variant_id: string; kind: string; quantity: string }>(
            `SELECT o.lot_id, l.code, o.variant_id, o.kind, o.quantity FROM work_order_outputs o LEFT JOIN stock_lots l ON l.id = o.lot_id WHERE o.work_order_id = $1 ORDER BY o.seq`,
            [w.id],
          );
          orders.push({
            depth, workOrderId: w.id, woNumber: w.wo_number, status: w.status,
            outputs: outs.rows.map((o) => ({ variantId: o.variant_id, kind: o.kind, lotId: o.lot_id, lotCode: o.code, quantity: normalize(o.quantity) })),
          });
          for (const o of outs.rows) if (o.lot_id && !visited.has(o.lot_id)) { visited.add(o.lot_id); next.push(o.lot_id); }
        }
        frontier = next;
      }
    }

    const result: Record<string, unknown> = {
      lot: { id: start.rows[0].id, code: start.rows[0].code, variantId: start.rows[0].variant_id, kind: start.rows[0].kind, holdStatus: start.rows[0].hold_status },
      direction: q.direction,
      workOrders: orders,
    };
    if (q.direction === 'forward') {
      // Where the affected material ended up: every lot reached, and the retail sales of those lots.
      const sales = await db.query<{ quantity: string }>(
        `SELECT s.receipt_number AS "receiptNumber", s.status, s.created_at AS "soldAt", l.lot_id AS "lotId", sl.code AS "lotCode", l.quantity
           FROM pos_sale_lines l JOIN pos_sales s ON s.id = l.sale_id JOIN stock_lots sl ON sl.id = l.lot_id
          WHERE s.organization_id = $1 AND l.lot_id = ANY($2::uuid[]) AND s.status <> 'cancelled' ORDER BY s.created_at`,
        [orgId, [...visited]],
      );
      result.affectedLotIds = [...visited];
      result.sales = sales.rows.map((r) => ({ ...r, quantity: normalize(r.quantity) }));
    } else {
      result.materialLotIds = [...visited].filter((id) => id !== q.lotId);
    }
    return result;
  });
};
