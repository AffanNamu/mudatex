import type { Db } from '../db.js';
import { normalize } from '../domain/decimal.js';

export const RETURN_REASONS = ['damaged', 'wrong_item', 'not_wanted', 'other'] as const;

/** The returns asked for on one order, newest first, with their lines. Shown to the buyer and to staff. */
export async function listReturns(q: Pick<Db, 'query'>, orderId: string) {
  const { rows } = await q.query(
    `SELECT r.id, r.status, r.reason, r.note, r.decision_note AS "decisionNote", r.refund_minor::float8 AS "refundMinor", r.created_at AS "createdAt", r.decided_at AS "decidedAt", r.received_at AS "receivedAt",
            (SELECT json_agg(json_build_object('lineNo', l.line_no, 'quantity', l.quantity::text, 'title', ol.title, 'restocked', l.restocked) ORDER BY l.line_no)
               FROM order_return_lines l JOIN sales_order_lines ol ON ol.order_id = r.order_id AND ol.line_no = l.line_no WHERE l.return_id = r.id) AS lines
       FROM order_returns r WHERE r.order_id = $1 ORDER BY r.created_at DESC`, [orderId]);
  return rows.map((r) => ({ ...r, lines: (r.lines ?? []).map((l: { quantity: string }) => ({ ...l, quantity: normalize(l.quantity) })) }));
}
