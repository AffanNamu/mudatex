import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PaymentProvider, VerifyResult } from '../src/payments/paystack.js';
import { createPaystack, validSignature } from '../src/payments/paystack.js';
import { call, setupApp } from './helpers.js';
import { balance } from './inventory-helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

const SECRET = 'sk_test_abcdef123456';

/** A payment provider the tests control: what it says about a reference is whatever the test sets. */
class FakeProvider implements PaymentProvider {
  readonly name = 'paystack' as const;
  initialized: { email: string; amountMinor: number; currency: string; reference: string; callbackUrl: string }[] = [];
  results = new Map<string, VerifyResult>();
  verifyCalls = 0;
  async initialize(i: (typeof this.initialized)[number]) {
    this.initialized.push(i);
    return { authorizationUrl: `https://checkout.paystack.test/${i.reference}` };
  }
  async verify(reference: string): Promise<VerifyResult> {
    this.verifyCalls++;
    return this.results.get(reference) ?? { status: 'pending', amountMinor: 0, currency: '', reference };
  }
  pay(reference: string, amountMinor: number, currency = 'NGN', status: VerifyResult['status'] = 'success') {
    this.results.set(reference, { status, amountMinor, currency, reference });
  }
}

let ctx: Awaited<ReturnType<typeof setupApp>>;
const provider = new FakeProvider();
beforeAll(async () => { ctx = await setupApp({ PAYSTACK_SECRET_KEY: SECRET }, { payments: provider }); });
afterAll(async () => { await ctx.close(); });

async function readyCard() {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { siteUrl: 'https://shop.example.test/' });
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  const c = await shopper(`card-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Card Payer' });
  const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Card Payer', phone: '+2348011111111', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
  const order = await call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...c.auth, 'idempotency-key': crypto.randomUUID() }, {
    lines: [{ variantId: s.w.fabric.variantId, quantity: '2' }], addressId: addr.body.id, paymentMethod: 'card',
  });
  expect(order.status).toBe(201);
  return { s, c, order: order.body, pay: () => call(ctx.app, 'POST', `/shop/${s.slug}/me/orders/${order.body.orderNo}/pay`, c.auth) };
}

const webhook = (body: unknown, secret = SECRET, tamper = false) => {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha512', secret).update(raw).digest('hex');
  return ctx.app.inject({ method: 'POST', url: '/webhooks/paystack', headers: { 'content-type': 'application/json', 'x-paystack-signature': tamper ? sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0') : sig }, payload: raw });
};

describe('starting a card payment', () => {
  it('charges the order total, never an amount from the request, and returns the provider page', async () => {
    const r = await readyCard();
    // 2 m x 3,500.50 + 7.5% = 7,526.08 ; + 1,000.00 delivery
    expect(r.order.totalMinor).toBe(752608 + 100000);
    const res = await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders/${r.order.orderNo}/pay`, r.c.auth, { amountMinor: 1 });
    expect(res.status).toBe(200);
    expect(res.body.authorizationUrl).toBe(`https://checkout.paystack.test/${res.body.reference}`);
    const sent = provider.initialized.at(-1)!;
    expect(sent).toMatchObject({ amountMinor: 852608, currency: 'NGN', email: expect.stringContaining('card-') });
    expect(sent.callbackUrl).toBe(`https://shop.example.test/orders/${r.order.orderNo}?paid=1&reference=${encodeURIComponent(res.body.reference)}`);
  });

  it('refuses bank-transfer orders, other people\'s orders, closed orders and stores without a site address', async () => {
    const r = await readyCard();
    const other = await shopper(`other-${uniq()}@example.test`);
    await call(ctx.app, 'POST', `/shop/${r.s.slug}/me`, other.auth, { fullName: 'Other Person' });
    expect((await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders/${r.order.orderNo}/pay`, other.auth)).status).toBe(404);
    await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders/${r.order.orderNo}/cancel`, r.c.auth);
    expect((await r.pay()).status).toBe(409);

    const transfer = await readyCard();
    await ctx.db.query(`UPDATE sales_orders SET payment_method = 'bank_transfer' WHERE id = $1`, [transfer.order.id]);
    expect((await transfer.pay()).status).toBe(422);

    const noSite = await readyCard();
    await ctx.db.query(`UPDATE storefronts SET site_url = NULL WHERE slug = $1`, [noSite.s.slug]);
    expect((await noSite.pay()).status).toBe(409);
  });
});

describe('confirming a card payment', () => {
  it('books the payment only when the provider confirms the exact amount, and only once', async () => {
    const r = await readyCard();
    const { reference } = (await r.pay()).body;
    const check = () => call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders/${r.order.orderNo}/payment-check`, r.c.auth, { reference });
    // not paid yet: the shopper came back before finishing
    expect((await check()).body).toMatchObject({ outcome: 'pending', order: { status: 'pending_payment' } });
    provider.pay(reference, 852608);
    const paid = await check();
    expect(paid.body).toMatchObject({ outcome: 'succeeded', order: { status: 'paid', paidMinor: 852608 } });
    // asking again changes nothing and does not call the provider again
    const calls = provider.verifyCalls;
    expect((await check()).body.outcome).toBe('succeeded');
    expect(provider.verifyCalls).toBe(calls);
    const detail = await call(ctx.app, 'GET', `/v1/sales-orders/${r.order.id}`, r.s.a);
    expect(detail.body.payments).toEqual([expect.objectContaining({ method: 'card', reference, amountMinor: 852608 })]);
    expect(detail.body.refundDueMinor).toBe(0);
  });

  it('does not trust a browser that claims success: a short amount or other currency leaves the order unpaid', async () => {
    const r = await readyCard();
    const { reference } = (await r.pay()).body;
    provider.pay(reference, 100);
    const res = await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders/${r.order.orderNo}/payment-check`, r.c.auth, { reference });
    expect(res.body).toMatchObject({ outcome: 'mismatch', order: { status: 'pending_payment', paidMinor: 0 } });
    const { rows } = await ctx.db.query('SELECT status, detail FROM payment_attempts WHERE reference = $1', [reference]);
    expect(rows[0]).toMatchObject({ status: 'mismatch' });

    const r2 = await readyCard();
    const ref2 = (await r2.pay()).body.reference;
    provider.pay(ref2, 852608, 'USD');
    expect((await call(ctx.app, 'POST', `/shop/${r2.s.slug}/me/orders/${r2.order.orderNo}/payment-check`, r2.c.auth, { reference: ref2 })).body.outcome).toBe('mismatch');
  });

  it('records a failed or abandoned payment and lets the shopper try again with a new reference', async () => {
    const r = await readyCard();
    const first = (await r.pay()).body.reference;
    provider.pay(first, 0, 'NGN', 'abandoned');
    expect((await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders/${r.order.orderNo}/payment-check`, r.c.auth, { reference: first })).body.outcome).toBe('failed');
    const second = (await r.pay()).body.reference;
    expect(second).not.toBe(first);
    provider.pay(second, 852608);
    expect((await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders/${r.order.orderNo}/payment-check`, r.c.auth, { reference: second })).body.order.status).toBe('paid');
  });

  it('will not check a reference that belongs to someone else\'s order', async () => {
    const a = await readyCard();
    const b = await readyCard();
    const { reference } = (await a.pay()).body;
    provider.pay(reference, 852608);
    const res = await call(ctx.app, 'POST', `/shop/${b.s.slug}/me/orders/${b.order.orderNo}/payment-check`, b.c.auth, { reference });
    expect(res.status).toBe(404);
  });
});

describe('the Paystack webhook', () => {
  it('settles a payment from a correctly signed event even if the shopper never came back', async () => {
    const r = await readyCard();
    const { reference } = (await r.pay()).body;
    provider.pay(reference, 852608);
    const res = await webhook({ event: 'charge.success', data: { reference } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ outcome: 'succeeded' });
    expect((await call(ctx.app, 'GET', `/v1/sales-orders/${r.order.id}`, r.s.a)).body.status).toBe('paid');
    // Paystack retries; the second delivery is harmless
    expect((await webhook({ event: 'charge.success', data: { reference } })).statusCode).toBe(200);
    expect((await call(ctx.app, 'GET', `/v1/sales-orders/${r.order.id}`, r.s.a)).body.payments).toHaveLength(1);
  });

  it('rejects wrong or missing signatures and ignores events it does not act on', async () => {
    const r = await readyCard();
    const { reference } = (await r.pay()).body;
    provider.pay(reference, 852608);
    expect((await webhook({ event: 'charge.success', data: { reference } }, SECRET, true)).statusCode).toBe(401);
    expect((await webhook({ event: 'charge.success', data: { reference } }, 'sk_test_someoneelse')).statusCode).toBe(401);
    const unsigned = await ctx.app.inject({ method: 'POST', url: '/webhooks/paystack', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(unsigned.statusCode).toBe(401);
    expect((await call(ctx.app, 'GET', `/v1/sales-orders/${r.order.id}`, r.s.a)).body.status).toBe('pending_payment');
    expect(JSON.parse((await webhook({ event: 'transfer.success', data: { reference } })).body)).toMatchObject({ ignored: true });
    expect(JSON.parse((await webhook({ event: 'charge.success', data: { reference: 'NOPE-00000000' } })).body)).toMatchObject({ ignored: true });
  });

  it('keeps money that arrives after the order lapsed and records the refund owed, returning the stock hold', async () => {
    const r = await readyCard();
    const { reference } = (await r.pay()).body;
    await ctx.db.query(`UPDATE sales_orders SET expires_at = now() - interval '1 minute' WHERE id = $1`, [r.order.id]);
    const { expireUnpaidOrders } = await import('../src/shop/orders.js');
    await expireUnpaidOrders(ctx.db);
    expect((await call(ctx.app, 'GET', `/v1/sales-orders/${r.order.id}`, r.s.a)).body.status).toBe('expired');
    provider.pay(reference, 852608);
    await webhook({ event: 'charge.success', data: { reference } });
    const d = await call(ctx.app, 'GET', `/v1/sales-orders/${r.order.id}`, r.s.a);
    expect(d.body).toMatchObject({ status: 'expired', paidMinor: 852608, refundDueMinor: 852608 });
    expect(d.body.payments).toHaveLength(1);
    expect(d.body.events.at(-1).note).toMatch(/refund owed/);
    // the reserved stock stayed released
    expect((await balance(ctx.app, r.s.a, { locationId: r.s.w.shop, variantId: r.s.w.fabric.variantId })).reserved).toBe('0');
  });
});

describe('the Paystack client', () => {
  it('verifies webhook signatures in constant time and rejects length mismatches', () => {
    const body = '{"event":"charge.success"}';
    const sig = createHmac('sha512', SECRET).update(body).digest('hex');
    expect(validSignature(body, sig, SECRET)).toBe(true);
    expect(validSignature(body, sig.slice(1), SECRET)).toBe(false);
    expect(validSignature(body, undefined, SECRET)).toBe(false);
  });

  it('sends the amount in minor units and maps the provider answer', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      const data = url.includes('/verify/') ? { status: 'success', amount: 852608, currency: 'NGN', reference: 'REF-1' } : { authorization_url: 'https://checkout.paystack.com/abc' };
      return new Response(JSON.stringify({ status: true, data }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createPaystack(SECRET, fake);
    expect(await client.initialize({ email: 'a@b.test', amountMinor: 852608, currency: 'NGN', reference: 'REF-1', callbackUrl: 'https://x.test/cb' })).toEqual({ authorizationUrl: 'https://checkout.paystack.com/abc' });
    expect(JSON.parse(seen[0]!.init.body as string)).toMatchObject({ amount: 852608, currency: 'NGN', callback_url: 'https://x.test/cb' });
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
    expect(await client.verify('REF-1')).toEqual({ status: 'success', amountMinor: 852608, currency: 'NGN', reference: 'REF-1' });
    const down = createPaystack(SECRET, (async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    await expect(down.verify('REF-1')).rejects.toMatchObject({ status: 502 });
  });
});

describe('advertising card payments', () => {
  it('tells the shop card payment is on only when a provider and the store address exist', async () => {
    const r = await readyCard();
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}`, undefined)).body.cardPayments).toBe(true);
    await ctx.db.query(`UPDATE storefronts SET site_url = NULL WHERE slug = $1`, [r.s.slug]);
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}`, undefined)).body.cardPayments).toBe(false);
  });
});
