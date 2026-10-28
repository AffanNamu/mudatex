import { createHash } from 'node:crypto';
import { writeAudit } from '../audit.js';
import { withTx, type Db, type Tx } from '../db.js';
import { fromScaled, toScaled } from '../domain/decimal.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';
import { publishEvent } from '../events/publish.js';
import { stable } from '../idempotency.js';
import { postMovements, type Posting } from '../inventory/ledger.js';
import { requestRefundTx } from './refunds.js';
import { RETURN_REASONS } from './returns-read.js';

export { listReturns } from './returns-read.js';

const OPEN = ['requested', 'approved', 'received'];

export interface ReturnInput { reason: (typeof RETURN_REASONS)[number]; note?: string; lines: { lineNo: number; quantity: string }[] }

async function orderEvent(tx: Tx, orderId: string, status: string, actorType: 'customer' | 'staff', actorId: string, note: string) {
  await tx.query('INSERT INTO sales_order_events (order_id, status, actor_type, actor_id, note) VALUES ($1, $2, $3, $4, $5)', [orderId, status, actorType, actorId, note]);
}

/** What the goods are worth to the customer: each line's total (tax and discount included) pro rata to the quantity returned. */
export function returnValue(lines: { total: bigint; ordered: string; returned: string }[]): bigint {
  let sum = 0n;
  for (const l of lines) {
    const ordered = toScaled(l.ordered);
    sum += (l.total * toScaled(l.returned) * 2n + ordered) / (ordered * 2n);
  }
  return sum;
}

/** A buyer asks to send goods back. Only for delivered orders, inside the store's return window, and never more than was bought. */
export async function requestReturn(db: Db, organizationId: string, customerId: string, orderNo: string, input: ReturnInput, clientKey: string, requestId?: string) {
  const hash = createHash('sha256').update(stable({ orderNo, ...input })).digest('hex');
  return withTx(db, async (tx) => {
    const o = await tx.query<{ id: string; status: string; delivered_at: Date | null; hours: number }>(
      `SELECT o.id, o.status, o.delivered_at, s.return_window_hours AS hours FROM sales_orders o JOIN storefronts s ON s.id = o.storefront_id
        WHERE o.organization_id = $1 AND o.order_no = $2 AND o.customer_id = $3 FOR UPDATE OF o`, [organizationId, orderNo, customerId]);
    const order = o.rows[0];
    if (!order) throw notFound('Order');
    const prior = await tx.query<{ id: string; request_hash: string }>('SELECT id, request_hash FROM order_returns WHERE customer_id = $1 AND client_key = $2', [customerId, clientKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== hash) throw invalid('Idempotency-Key was already used for a different request');
      return { id: prior.rows[0].id, replayed: true };
    }
    if (order.status !== 'delivered' || !order.delivered_at) throw conflict('Goods can be returned once the order has been delivered', { key: 'err.return.notDelivered' });
    if (order.hours === 0 || Date.now() > order.delivered_at.getTime() + order.hours * 3_600_000) throw conflict(`The time for returning goods from this order (${order.hours} hours after delivery) has passed. Contact the store.`, { key: 'err.return.closed', vars: { hours: order.hours } });

    const lines = await tx.query<{ line_no: number; quantity: string; held: string }>(
      `SELECT l.line_no, l.quantity::text,
              COALESCE((SELECT sum(rl.quantity) FROM order_return_lines rl JOIN order_returns r ON r.id = rl.return_id WHERE r.order_id = l.order_id AND rl.line_no = l.line_no AND r.status = ANY($2)), 0)::text AS held
         FROM sales_order_lines l WHERE l.order_id = $1`, [order.id, OPEN]);
    const byNo = new Map(lines.rows.map((l) => [l.line_no, l]));
    const seen = new Set<number>();
    for (const l of input.lines) {
      const line = byNo.get(l.lineNo);
      if (!line || seen.has(l.lineNo)) throw invalid('Choose items from this order, each once', { key: 'err.return.lines' });
      seen.add(l.lineNo);
      const room = toScaled(line.quantity) - toScaled(line.held);
      if (toScaled(l.quantity) <= 0n || toScaled(l.quantity) > room) throw invalid(`You can return at most ${fromScaled(room > 0n ? room : 0n)} of item ${l.lineNo}`, { key: 'err.return.quantity' });
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO order_returns (organization_id, order_id, customer_id, reason, note, client_key, request_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [organizationId, order.id, customerId, input.reason, input.note ?? null, clientKey, hash]);
    const id = rows[0]!.id;
    for (const l of input.lines) await tx.query('INSERT INTO order_return_lines (return_id, line_no, quantity) VALUES ($1,$2,$3)', [id, l.lineNo, l.quantity]);
    await orderEvent(tx, order.id, order.status, 'customer', customerId, `Return requested (${input.reason.replace('_', ' ')})`);
    await writeAudit(tx, { organizationId, actorUserId: null, requestId, action: 'order.return_request', entityType: 'order_return', entityId: id, after: { orderNo, reason: input.reason } });
    return { id, replayed: false };
  });
}

export async function cancelReturn(db: Db, organizationId: string, customerId: string, returnId: string, requestId?: string) {
  await withTx(db, async (tx) => {
    const r = await tx.query<{ status: string; order_id: string; status_now: string }>(
      `SELECT r.status, r.order_id, o.status AS status_now FROM order_returns r JOIN sales_orders o ON o.id = r.order_id
        WHERE r.id = $1 AND r.organization_id = $2 AND r.customer_id = $3 FOR UPDATE OF r`, [returnId, organizationId, customerId]);
    if (!r.rows[0]) throw notFound('Return');
    if (r.rows[0].status !== 'requested') throw conflict('This return can no longer be cancelled', { key: 'err.return.cancel' });
    await tx.query(`UPDATE order_returns SET status = 'cancelled' WHERE id = $1`, [returnId]);
    await orderEvent(tx, r.rows[0].order_id, r.rows[0].status_now, 'customer', customerId, 'Return request withdrawn');
    await writeAudit(tx, { organizationId, actorUserId: null, requestId, action: 'order.return_cancel', entityType: 'order_return', entityId: returnId });
  });
}

/**
 * Staff decide. Approving works out what the goods are worth and raises an ordinary refund request for it (limited to what
 * the customer has actually paid and not yet had back); a second person approves the money as with any refund.
 */
export async function decideReturn(db: Db, organizationId: string, returnId: string, userId: string, decision: 'approve' | 'reject', note: string | undefined, requestId?: string) {
  return withTx(db, async (tx) => {
    const r = await tx.query<{ status: string; order_id: string; reason: string }>('SELECT status, order_id, reason FROM order_returns WHERE id = $1 AND organization_id = $2 FOR UPDATE', [returnId, organizationId]);
    const row = r.rows[0];
    if (!row) throw notFound('Return');
    if (row.status !== 'requested') throw conflict(`This return is already ${row.status}`);
    if (decision === 'reject' && !note) throw invalid('Say why the return is declined: the customer is told');
    const order = await tx.query<{ status: string; paid_minor: string }>('SELECT status, paid_minor FROM sales_orders WHERE id = $1', [row.order_id]);
    let refundMinor = 0n; let refundId: string | null = null; let detail = note ?? null;
    if (decision === 'approve') {
      const lines = await tx.query<{ total: string; ordered: string; returned: string }>(
        `SELECT l.total_minor AS total, l.quantity::text AS ordered, rl.quantity::text AS returned FROM order_return_lines rl JOIN sales_order_lines l ON l.order_id = $2 AND l.line_no = rl.line_no WHERE rl.return_id = $1`, [returnId, row.order_id]);
      const worth = returnValue(lines.rows.map((l) => ({ total: BigInt(l.total), ordered: l.ordered, returned: l.returned })));
      const open = await tx.query<{ n: string }>(`SELECT COALESCE(sum(amount_minor), 0) AS n FROM order_refunds WHERE order_id = $1 AND status IN ('requested','approved','processing','paid')`, [row.order_id]);
      const room = BigInt(order.rows[0]!.paid_minor) - BigInt(open.rows[0]!.n);
      refundMinor = worth < room ? worth : room > 0n ? room : 0n;
      if (refundMinor > 0n) refundId = await requestRefundTx(tx, organizationId, row.order_id, userId, { amountMinor: Number(refundMinor), reason: `Return of goods (${row.reason.replace('_', ' ')})` }, requestId);
      else detail = [note, 'Nothing has been paid that could be refunded, so no refund was raised.'].filter(Boolean).join(' ');
    }
    await tx.query(`UPDATE order_returns SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, refund_minor = $5, refund_id = $6 WHERE id = $1`,
      [returnId, decision === 'approve' ? 'approved' : 'rejected', userId, detail, refundMinor, refundId]);
    await orderEvent(tx, row.order_id, order.rows[0]!.status, 'staff', userId, `Return ${decision === 'approve' ? 'approved' : 'declined'}${note ? `: ${note}` : ''}`);
    await publishEvent(tx, { organizationId, type: 'order.return_decided', aggregateType: 'order_return', aggregateId: returnId, actorUserId: userId, requestId });
    await writeAudit(tx, { organizationId, actorUserId: userId, requestId, action: `order.return_${decision}`, entityType: 'order_return', entityId: returnId, after: { refundMinor: Number(refundMinor) } });
    return { refundMinor: Number(refundMinor), refundId };
  });
}

/** The goods are back with us. The ones in good condition go on the shelf at the chosen location. */
export async function receiveReturn(db: Db, organizationId: string, returnId: string, userId: string, input: { locationId: string; restockLines: number[] }, requestId?: string) {
  await withTx(db, async (tx) => {
    const r = await tx.query<{ status: string; order_id: string }>('SELECT status, order_id FROM order_returns WHERE id = $1 AND organization_id = $2 FOR UPDATE', [returnId, organizationId]);
    const row = r.rows[0];
    if (!row) throw notFound('Return');
    if (row.status !== 'approved') throw conflict(row.status === 'received' ? 'These goods were already booked in' : 'Only an approved return can be booked in');
    const lines = await tx.query<{ line_no: number; quantity: string; variant_id: string; tracking: string; sku: string }>(
      `SELECT rl.line_no, rl.quantity::text, l.variant_id, v.tracking, l.sku FROM order_return_lines rl
         JOIN sales_order_lines l ON l.order_id = $2 AND l.line_no = rl.line_no JOIN product_variants v ON v.id = l.variant_id WHERE rl.return_id = $1`, [returnId, row.order_id]);
    const wanted = new Set(input.restockLines);
    for (const n of wanted) if (!lines.rows.some((l) => l.line_no === n)) throw invalid(`Item ${n} is not part of this return`);
    const postings: Posting[] = [];
    for (const l of lines.rows) {
      if (!wanted.has(l.line_no)) continue;
      if (l.tracking !== 'none') throw invalid(`${l.sku} is tracked by roll or lot: add it back through Inventory so its roll or lot code is kept`);
      postings.push({ locationId: input.locationId, variantId: l.variant_id, lotId: null, state: 'on_hand', delta: l.quantity, type: 'sale_return' });
    }
    if (postings.length) {
      const loc = await tx.query('SELECT 1 FROM locations l JOIN legal_entities e ON e.id = l.legal_entity_id JOIN sales_orders o ON o.legal_entity_id = e.id WHERE l.id = $1 AND o.id = $2', [input.locationId, row.order_id]);
      if (!loc.rowCount) throw invalid('Choose a location of the company that sold the goods');
      await postMovements(tx, { organizationId, actorUserId: userId, requestId, reason: 'Online order return', referenceType: 'order_return', referenceId: returnId }, postings);
      await tx.query('UPDATE order_return_lines SET restocked = true WHERE return_id = $1 AND line_no = ANY($2)', [returnId, [...wanted]]);
    }
    await tx.query(`UPDATE order_returns SET status = 'received', received_by = $2, received_at = now() WHERE id = $1`, [returnId, userId]);
    const st = await tx.query<{ status: string }>('SELECT status FROM sales_orders WHERE id = $1', [row.order_id]);
    await orderEvent(tx, row.order_id, st.rows[0]!.status, 'staff', userId, `Returned goods received${wanted.size ? `; ${wanted.size} item${wanted.size === 1 ? '' : 's'} put back on the shelf` : ''}`);
    await writeAudit(tx, { organizationId, actorUserId: userId, requestId, action: 'order.return_received', entityType: 'order_return', entityId: returnId, after: { restocked: [...wanted] } });
  });
}
