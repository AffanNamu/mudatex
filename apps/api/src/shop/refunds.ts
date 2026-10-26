import { writeAudit } from '../audit.js';
import { withTx, type Db, type Tx } from '../db.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';
import type { PaymentProvider } from '../payments/paystack.js';
import { lockOrder } from './orders.js';

const OPEN = ['requested', 'approved', 'processing', 'paid'];

interface RefundRow {
  id: string; order_id: string; organization_id: string; amount_minor: string; method: 'card' | 'bank_transfer'; payment_reference: string | null;
  status: string; requested_by: string; provider_ref: string | null;
}

const view = (r: any) => ({ ...r, amountMinor: Number(r.amountMinor) });
export const REFUND_COLUMNS = `id, order_id AS "orderId", amount_minor AS "amountMinor", reason, method, payment_reference AS "paymentReference", status, requested_by AS "requestedBy",
  decided_by AS "decidedBy", provider_ref AS "providerRef", payout_ref AS "payoutRef", detail, created_at AS "createdAt", settled_at AS "settledAt"`;

async function event(tx: Tx, orderId: string, status: string, note: string) {
  await tx.query(`INSERT INTO sales_order_events (order_id, status, actor_type, note) VALUES ($1, $2, 'staff', $3)`, [orderId, status, note]);
}
const audit = (tx: Tx, organizationId: string, userId: string, action: string, id: string, after: unknown, requestId?: string) =>
  writeAudit(tx, { organizationId, actorUserId: userId, requestId, action, entityType: 'order_refund', entityId: id, after });

export async function listRefunds(db: Pick<Db, 'query'>, orderId: string) {
  const { rows } = await db.query(`SELECT ${REFUND_COLUMNS} FROM order_refunds WHERE order_id = $1 ORDER BY created_at`, [orderId]);
  return rows.map(view);
}

/** Asks for money to go back to the customer. Someone else must approve it before anything is sent. */
export async function requestRefund(
  db: Db, organizationId: string, orderId: string, userId: string,
  input: { amountMinor: number; reason: string; method?: 'card' | 'bank_transfer' }, requestId?: string,
) {
  return withTx(db, async (tx) => {
    const o = await lockOrder(tx, organizationId, { id: orderId });
    if (BigInt(o.paid_minor) === 0n) throw conflict('Nothing has been paid on this order');
    const open = await tx.query<{ n: string }>(`SELECT COALESCE(sum(amount_minor), 0) AS n FROM order_refunds WHERE order_id = $1 AND status = ANY($2)`, [orderId, OPEN]);
    const room = BigInt(o.paid_minor) - BigInt(open.rows[0]!.n);
    if (BigInt(input.amountMinor) > room) throw invalid(`At most ${room} can still be refunded on this order`);

    // Prefer sending the money back the way it came: the latest card payment that still has room.
    let method: 'card' | 'bank_transfer' = 'bank_transfer';
    let reference: string | null = null;
    if (input.method !== 'bank_transfer') {
      const card = await tx.query<{ reference: string; left: string }>(
        `SELECT p.reference, p.amount_minor - COALESCE((SELECT sum(r.amount_minor) FROM order_refunds r WHERE r.payment_reference = p.reference AND r.status = ANY($2)), 0) AS "left"
           FROM sales_order_payments p WHERE p.order_id = $1 AND p.method = 'card' AND p.provider = 'paystack' ORDER BY p.created_at DESC`,
        [orderId, OPEN],
      );
      const fit = card.rows.find((c) => BigInt(c.left) >= BigInt(input.amountMinor));
      if (fit) { method = 'card'; reference = fit.reference; }
      else if (input.method === 'card') throw invalid('No single card payment on this order has enough left to refund that amount; refund by bank transfer instead');
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO order_refunds (organization_id, order_id, amount_minor, reason, method, payment_reference, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [organizationId, orderId, input.amountMinor, input.reason, method, reference, userId],
    );
    await event(tx, orderId, o.status, `Refund of ${input.amountMinor} requested (${method.replace('_', ' ')}): ${input.reason}`);
    await audit(tx, organizationId, userId, 'order.refund_request', rows[0]!.id, { orderId, amountMinor: input.amountMinor, method }, requestId);
    return rows[0]!.id;
  });
}

async function lockRefund(tx: Tx, organizationId: string, id: string): Promise<RefundRow> {
  const { rows } = await tx.query<RefundRow>(
    'SELECT id, order_id, organization_id, amount_minor, method, payment_reference, status, requested_by, provider_ref FROM order_refunds WHERE id = $1 AND organization_id = $2 FOR UPDATE',
    [id, organizationId],
  );
  if (!rows[0]) throw notFound('Refund');
  return rows[0];
}

/** Money has gone back: the order's refund-owed figure comes down and the customer's timeline records it. */
async function markPaid(tx: Tx, r: RefundRow, userId: string | null, payoutRef: string | null, requestId?: string) {
  await tx.query(`UPDATE order_refunds SET status = 'paid', payout_ref = COALESCE($2, payout_ref), settled_at = now() WHERE id = $1`, [r.id, payoutRef]);
  await tx.query(`UPDATE sales_orders SET refund_due_minor = GREATEST(refund_due_minor - $2, 0) WHERE id = $1`, [r.order_id, r.amount_minor]);
  const o = await tx.query<{ status: string }>('SELECT status FROM sales_orders WHERE id = $1', [r.order_id]);
  await event(tx, r.order_id, o.rows[0]!.status, `Refund of ${r.amount_minor} sent`);
  await writeAudit(tx, { organizationId: r.organization_id, actorUserId: userId, requestId, action: 'order.refund_paid', entityType: 'order_refund', entityId: r.id, after: { amountMinor: Number(r.amount_minor) } });
}

/** A second person's decision. Approving a card refund sends it through the provider straight away. */
export async function decideRefund(
  db: Db, provider: PaymentProvider | undefined, organizationId: string, refundId: string, userId: string,
  decision: 'approve' | 'reject', note?: string, requestId?: string,
) {
  const r = await withTx(db, async (tx) => {
    const row = await lockRefund(tx, organizationId, refundId);
    if (row.status !== 'requested') throw conflict(`This refund is already ${row.status}`);
    if (row.requested_by === userId) throw forbidden('A refund must be approved by someone other than the person who asked for it');
    await tx.query(`UPDATE order_refunds SET status = $2, decided_by = $3, decided_at = now(), detail = COALESCE($4, detail) WHERE id = $1`, [row.id, decision === 'approve' ? 'approved' : 'rejected', userId, note ?? null]);
    await event(tx, row.order_id, (await tx.query<{ status: string }>('SELECT status FROM sales_orders WHERE id = $1', [row.order_id])).rows[0]!.status, `Refund of ${row.amount_minor} ${decision === 'approve' ? 'approved' : 'declined'}`);
    await audit(tx, organizationId, userId, `order.refund_${decision}`, row.id, { note }, requestId);
    return row;
  });
  if (decision === 'reject' || r.method === 'bank_transfer') return;
  // card: ask the provider outside any database transaction, then record what it said
  if (!provider) {
    await db.query(`UPDATE order_refunds SET status = 'failed', detail = 'Card payments are not configured' WHERE id = $1`, [r.id]);
    throw conflict('Card payments are not configured, so this refund could not be sent; refund by bank transfer instead');
  }
  try {
    const sent = await provider.refund({ reference: r.payment_reference!, amountMinor: Number(r.amount_minor) });
    await withTx(db, async (tx) => {
      const row = await lockRefund(tx, organizationId, r.id);
      await tx.query('UPDATE order_refunds SET provider_ref = $2, status = $3 WHERE id = $1', [r.id, sent.providerRef, 'processing']);
      if (sent.status === 'processed') await markPaid(tx, { ...row, provider_ref: sent.providerRef }, null, sent.providerRef, requestId);
    });
  } catch (err) {
    await db.query(`UPDATE order_refunds SET status = 'failed', detail = $2 WHERE id = $1`, [r.id, (err as Error).message.slice(0, 300)]);
    throw err;
  }
}

/** Staff record that a bank refund (or a stuck card refund) has been paid out. */
export async function confirmRefundPaid(db: Db, organizationId: string, refundId: string, userId: string, payoutRef: string, requestId?: string) {
  await withTx(db, async (tx) => {
    const row = await lockRefund(tx, organizationId, refundId);
    if (!['approved', 'processing', 'failed'].includes(row.status)) throw conflict(`A refund that is ${row.status} cannot be marked as paid`);
    await markPaid(tx, row, userId, payoutRef, requestId);
  });
}

/** A provider notice about a card refund. Matched by the provider's reference; anything unknown is ignored. */
export async function applyProviderRefundEvent(db: Db, providerRef: string, outcome: 'processed' | 'failed') {
  await withTx(db, async (tx) => {
    const { rows } = await tx.query<RefundRow>(
      `SELECT id, order_id, organization_id, amount_minor, method, payment_reference, status, requested_by, provider_ref FROM order_refunds WHERE provider_ref = $1 FOR UPDATE`,
      [providerRef],
    );
    const r = rows[0];
    if (!r || r.status === 'paid') return;
    if (outcome === 'processed') await markPaid(tx, r, null, providerRef);
    else await tx.query(`UPDATE order_refunds SET status = 'failed', detail = 'The payment provider could not complete this refund' WHERE id = $1`, [r.id]);
  });
}
