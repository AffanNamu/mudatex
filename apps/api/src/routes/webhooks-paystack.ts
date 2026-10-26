import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db.js';
import { validSignature, type PaymentProvider } from '../payments/paystack.js';
import { settleCardPayment } from '../shop/card-payments.js';
import { applyProviderRefundEvent } from '../shop/refunds.js';

/**
 * Paystack calls this when a payment succeeds, whether or not the shopper's browser came back. The signature proves the
 * call is Paystack's; the payment itself is then checked with Paystack again before anything is booked.
 */
export const paystackWebhookRoutes: FastifyPluginAsync<{ db: Db; provider: PaymentProvider; secretKey: string }> = async (app, { db, provider, secretKey }) => {
  // The signature covers the exact bytes sent, so this route keeps the body unparsed.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/paystack', async (req, reply) => {
    const raw = req.body as Buffer;
    if (!validSignature(raw, req.headers['x-paystack-signature'] as string | undefined, secretKey)) {
      return reply.status(401).send({ error: 'unauthorized', message: 'Bad signature' });
    }
    let event: { event?: string; data?: { reference?: string; id?: number | string; refund_reference?: string } };
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply.status(400).send({ error: 'bad_request', message: 'Invalid JSON' });
    }
    if (event.event === 'refund.processed' || event.event === 'refund.failed') {
      const ref = String(event.data?.id ?? event.data?.refund_reference ?? '');
      if (ref) await applyProviderRefundEvent(db, ref, event.event === 'refund.processed' ? 'processed' : 'failed');
      return reply.status(200).send({ ok: true });
    }
    // Only successful charges matter; everything else is acknowledged and ignored so Paystack stops retrying.
    if (event.event !== 'charge.success' || !event.data?.reference) return reply.status(200).send({ ok: true, ignored: true });
    try {
      const result = await settleCardPayment(db, provider, event.data.reference, req.id);
      return reply.status(200).send({ ok: true, outcome: result.outcome });
    } catch (err) {
      if ((err as { status?: number }).status === 404) return reply.status(200).send({ ok: true, ignored: true });
      throw err;
    }
  });
};

