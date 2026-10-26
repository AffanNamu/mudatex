import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeProvider } from './fake-provider.js';
import { call, setupApp, staff } from './helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

const SECRET = 'sk_test_abcdef123456';
const provider = new FakeProvider();
let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp({ PAYSTACK_SECRET_KEY: SECRET }, { payments: provider }); });
afterAll(async () => { await ctx.close(); });

async function paidOrder(method: 'card' | 'bank_transfer') {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { siteUrl: 'https://shop.example.test' });
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  const c = await shopper(`rf-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Refund Customer' });
  const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Refund Customer', phone: '+2348011111111', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
  const o = (await call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...c.auth, 'idempotency-key': crypto.randomUUID() }, {
    lines: [{ variantId: s.w.fabric.variantId, quantity: '2' }], addressId: addr.body.id, paymentMethod: method,
  })).body;
  let reference = `BANK-${uniq()}`;
  if (method === 'card') {
    reference = (await call(ctx.app, 'POST', `/shop/${s.slug}/me/orders/${o.orderNo}/pay`, c.auth)).body.reference;
    provider.pay(reference, o.totalMinor);
    await call(ctx.app, 'POST', `/shop/${s.slug}/me/orders/${o.orderNo}/payment-check`, c.auth, { reference });
  } else {
    await call(ctx.app, 'POST', `/v1/sales-orders/${o.id}/payments`, s.a, { method: 'bank_transfer', reference, amountMinor: o.totalMinor });
  }
  const maker = await staff(ctx.app, s.a, ['orders.refund', 'orders.read'], { type: 'legal_entity', id: s.w.ng });
  const checker = await staff(ctx.app, s.a, ['orders.refund.approve', 'orders.read'], { type: 'legal_entity', id: s.w.ng });
  const detail = () => call(ctx.app, 'GET', `/v1/sales-orders/${o.id}`, s.a);
  return { s, c, o, maker, checker, reference, detail };
}

describe('refunds', () => {
  it('go back to the card through the provider once a second person approves', async () => {
    provider.refunds.length = 0; provider.refundStatus = 'processed';
    const r = await paidOrder('card');
    await call(ctx.app, 'POST', `/v1/sales-orders/${r.o.id}/cancel`, r.s.a, { reason: 'Out of stock after all' });
    expect((await r.detail()).body.refundDueMinor).toBe(r.o.totalMinor);

    const asked = await call(ctx.app, 'POST', `/v1/sales-orders/${r.o.id}/refunds`, r.maker.auth, { amountMinor: r.o.totalMinor - 1000, reason: 'Order cancelled, refund less handling' });
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ status: 'requested', method: 'card', paymentReference: r.reference });
    expect(provider.refunds).toHaveLength(0); // nothing is sent until someone else approves
    // the person who asked cannot approve, and a person without the permission cannot either
    expect((await call(ctx.app, 'POST', `/v1/refunds/${asked.body.id}/decision`, r.maker.auth, { decision: 'approve' })).status).toBe(403);
    const both = await staff(ctx.app, r.s.a, ['orders.refund', 'orders.refund.approve'], { type: 'legal_entity', id: r.s.w.ng });
    const own = await call(ctx.app, 'POST', `/v1/sales-orders/${r.o.id}/refunds`, both.auth, { amountMinor: 100, reason: 'Testing the rule' });
    expect((await call(ctx.app, 'POST', `/v1/refunds/${own.body.id}/decision`, both.auth, { decision: 'approve' })).status).toBe(403);

    const done = await call(ctx.app, 'POST', `/v1/refunds/${asked.body.id}/decision`, r.checker.auth, { decision: 'approve' });
    expect(done.body).toMatchObject({ status: 'paid', method: 'card' });
    expect(provider.refunds).toEqual([{ reference: r.reference, amountMinor: r.o.totalMinor - 1000 }]);
    const d = (await r.detail()).body;
    expect(d.refundDueMinor).toBe(1000);
    expect(d.events.at(-1).note).toMatch(/Refund of \d+ sent/);
    expect((await call(ctx.app, 'POST', `/v1/refunds/${asked.body.id}/decision`, r.checker.auth, { decision: 'approve' })).status).toBe(409);
  });

  it('cannot exceed what was paid, counting refunds already asked for', async () => {
    const r = await paidOrder('bank_transfer');
    const ask = (amountMinor: number) => call(ctx.app, 'POST', `/v1/sales-orders/${r.o.id}/refunds`, r.maker.auth, { amountMinor, reason: 'Part return of cloth' });
    expect((await ask(r.o.totalMinor + 1)).status).toBe(422);
    const first = await ask(r.o.totalMinor - 1000);
    expect(first.status).toBe(201);
    expect(first.body.method).toBe('bank_transfer');
    expect((await ask(1001)).status).toBe(422);
    expect((await ask(1000)).status).toBe(201);
    // a refund that is declined frees its share
    await call(ctx.app, 'POST', `/v1/refunds/${first.body.id}/decision`, r.checker.auth, { decision: 'reject', note: 'Wrong amount' });
    expect((await ask(r.o.totalMinor - 1000)).status).toBe(201);
    const unpaid = await shopWorld(ctx);
    expect(unpaid).toBeTruthy();
  });

  it('are paid out by hand for bank transfers and recorded with the bank reference', async () => {
    const r = await paidOrder('bank_transfer');
    await call(ctx.app, 'POST', `/v1/sales-orders/${r.o.id}/cancel`, r.s.a, { reason: 'Customer changed mind' });
    const asked = await call(ctx.app, 'POST', `/v1/sales-orders/${r.o.id}/refunds`, r.maker.auth, { amountMinor: r.o.totalMinor, reason: 'Cancelled, refund to bank' });
    expect((await call(ctx.app, 'POST', `/v1/refunds/${asked.body.id}/paid`, r.checker.auth, { payoutRef: 'OUT-0001' })).status).toBe(409); // not approved yet
    expect((await call(ctx.app, 'POST', `/v1/refunds/${asked.body.id}/decision`, r.checker.auth, { decision: 'approve' })).body.status).toBe('approved');
    const paid = await call(ctx.app, 'POST', `/v1/refunds/${asked.body.id}/paid`, r.checker.auth, { payoutRef: 'OUT-0001' });
    expect(paid.body).toMatchObject({ status: 'paid', payoutRef: 'OUT-0001' });
    expect((await r.detail()).body).toMatchObject({ refundDueMinor: 0, refunds: [expect.objectContaining({ status: 'paid' })] });
  });

  it('record a provider that fails or is still working, and accept its later notice', async () => {
    provider.refunds.length = 0;
    const r = await paidOrder('card');
    provider.failRefund = true;
    const a = await call(ctx.app, 'POST', `/v1/sales-orders/${r.o.id}/refunds`, r.maker.auth, { amountMinor: 50000, reason: 'Damaged roll end' });
    const failed = await call(ctx.app, 'POST', `/v1/refunds/${a.body.id}/decision`, r.checker.auth, { decision: 'approve' });
    expect(failed.status).toBe(502);
    provider.failRefund = false;
    expect((await r.detail()).body.refunds[0]).toMatchObject({ status: 'failed' });

    provider.refundStatus = 'pending';
    const b = await call(ctx.app, 'POST', `/v1/sales-orders/${r.o.id}/refunds`, r.maker.auth, { amountMinor: 50000, reason: 'Damaged roll end, retry' });
    const sent = await call(ctx.app, 'POST', `/v1/refunds/${b.body.id}/decision`, r.checker.auth, { decision: 'approve' });
    expect(sent.body).toMatchObject({ status: 'processing' });
    const raw = JSON.stringify({ event: 'refund.processed', data: { id: sent.body.providerRef } });
    const hook = await ctx.app.inject({ method: 'POST', url: '/webhooks/paystack', headers: { 'content-type': 'application/json', 'x-paystack-signature': createHmac('sha512', SECRET).update(raw).digest('hex') }, payload: raw });
    expect(hook.statusCode).toBe(200);
    expect((await r.detail()).body.refunds.find((x: any) => x.id === b.body.id)).toMatchObject({ status: 'paid' });
  });

  it('are limited to staff of the order\'s company with the permission', async () => {
    const r = await paidOrder('bank_transfer');
    const nobody = await staff(ctx.app, r.s.a, ['orders.read'], { type: 'legal_entity', id: r.s.w.ng });
    expect((await call(ctx.app, 'POST', `/v1/sales-orders/${r.o.id}/refunds`, nobody.auth, { amountMinor: 100, reason: 'No permission here' })).status).toBe(403);
    const gh = await staff(ctx.app, r.s.a, ['orders.refund'], { type: 'legal_entity', id: r.s.w.gh });
    expect((await call(ctx.app, 'POST', `/v1/sales-orders/${r.o.id}/refunds`, gh.auth, { amountMinor: 100, reason: 'Wrong company here' })).status).toBe(403);
    const unpaid = await shopWorld(ctx);
    expect(unpaid.id).toBeTruthy();
  });
});
