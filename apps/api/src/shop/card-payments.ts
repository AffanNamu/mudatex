import { withTx, type Db } from '../db.js';
import { conflict, invalid, notFound } from '../errors.js';
import type { PaymentProvider } from '../payments/paystack.js';
import { applyPayment, lockOrder, readOrder } from './orders.js';
import type { Storefront } from './catalog.js';

/** Starts a card payment for an order that is waiting for one and returns the provider's payment page address. */
export async function startCardPayment(db: Db, provider: PaymentProvider, sf: Storefront, customerId: string, orderNo: string) {
  if (!sf.siteUrl) throw conflict('Card payments are not set up for this store yet', { key: 'err.card.notSetUp' });
  const { rows } = await db.query<{ id: string; status: string; payment_method: string; total_minor: string; paid_minor: string; currency: string; email: string }>(
    `SELECT o.id, o.status, o.payment_method, o.total_minor, o.paid_minor, o.currency, c.email
       FROM sales_orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.organization_id = $1 AND o.order_no = $2 AND o.customer_id = $3`,
    [sf.organizationId, orderNo, customerId],
  );
  const o = rows[0];
  if (!o) throw notFound('Order');
  if (o.status !== 'pending_payment') throw conflict('This order is not waiting for payment', { key: 'err.card.notWaiting' });
  if (o.payment_method !== 'card') throw invalid('This order was placed for bank transfer', { key: 'err.card.bankOrder' });
  // The amount comes from the order, never from the request.
  const amount = Number(BigInt(o.total_minor) - BigInt(o.paid_minor));
  const reference = `${orderNo}-${crypto.randomUUID().slice(0, 8)}`;
  await db.query(
    `INSERT INTO payment_attempts (organization_id, order_id, provider, reference, amount_minor, currency) VALUES ($1, $2, $3, $4, $5, $6)`,
    [sf.organizationId, o.id, provider.name, reference, amount, o.currency],
  );
  const { authorizationUrl } = await provider.initialize({
    email: o.email, amountMinor: amount, currency: o.currency, reference,
    callbackUrl: `${sf.siteUrl}/orders/${orderNo}?paid=1&reference=${encodeURIComponent(reference)}`,
  });
  return { reference, authorizationUrl };
}

/**
 * Asks the provider what happened to a payment and books the result. Safe to call any number of times, from the
 * shopper's return page and from the provider's webhook alike: a reference settles at most once.
 */
export async function settleCardPayment(db: Db, provider: PaymentProvider, reference: string, requestId?: string) {
  const found = await db.query<{ id: string; organization_id: string; order_id: string; amount_minor: string; currency: string; status: string }>(
    'SELECT id, organization_id, order_id, amount_minor, currency, status FROM payment_attempts WHERE reference = $1',
    [reference],
  );
  const attempt = found.rows[0];
  if (!attempt) throw notFound('Payment');
  if (attempt.status === 'succeeded') return { outcome: 'succeeded' as const, orderId: attempt.order_id, organizationId: attempt.organization_id };

  const result = await provider.verify(reference);
  const actor = { type: 'system', id: null } as const;
  const outcome = await withTx(db, async (tx) => {
    const locked = await tx.query<{ status: string }>('SELECT status FROM payment_attempts WHERE id = $1 FOR UPDATE', [attempt.id]);
    if (locked.rows[0]!.status === 'succeeded') return 'succeeded' as const;
    if (result.status === 'failed' || result.status === 'abandoned') {
      await tx.query(`UPDATE payment_attempts SET status = 'failed', detail = $2, settled_at = now() WHERE id = $1`, [attempt.id, result.status]);
      return 'failed' as const;
    }
    if (result.status !== 'success') return 'pending' as const;
    if (BigInt(result.amountMinor) !== BigInt(attempt.amount_minor) || result.currency.toUpperCase() !== attempt.currency.trim().toUpperCase() || result.reference !== reference) {
      // Money moved but not the amount we asked for: keep it for a person to look at, and do not touch the order.
      await tx.query(`UPDATE payment_attempts SET status = 'mismatch', detail = $2, settled_at = now() WHERE id = $1`,
        [attempt.id, `Provider reports ${result.amountMinor} ${result.currency}; expected ${attempt.amount_minor} ${attempt.currency}`]);
      return 'mismatch' as const;
    }
    const order = await lockOrder(tx, attempt.organization_id, { id: attempt.order_id });
    const how = await applyPayment(tx, attempt.organization_id, order, { method: 'card', provider: provider.name, reference, amountMinor: Number(attempt.amount_minor) }, actor, requestId);
    await tx.query(`UPDATE payment_attempts SET status = 'succeeded', detail = $2, settled_at = now() WHERE id = $1`, [attempt.id, how === 'refund_due' ? 'late payment; refund owed' : null]);
    return 'succeeded' as const;
  });
  return { outcome, orderId: attempt.order_id, organizationId: attempt.organization_id };
}

export { readOrder };
