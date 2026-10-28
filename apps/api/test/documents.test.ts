import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, staff } from './helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

async function placed(method: 'bank_transfer' | 'account' = 'bank_transfer') {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, {
    contact: { address: '12 Kwari Market, Kano', phone: '+2348000000001', email: 'sales@example.test', bankName: 'Test Bank', accountName: 'Textiles Ltd', accountNumber: '0123456789', taxId: 'TIN-445566', invoiceFooter: 'Goods once sold are not returnable uncut.' },
  });
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  const c = await shopper(`doc-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Amina Yusuf', phone: '+2348011111111' });
  const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Amina Yusuf', phone: '+2348011111111', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
  const order = await call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...c.auth, 'idempotency-key': crypto.randomUUID() }, { lines: [{ variantId: s.w.fabric.variantId, quantity: '2' }], addressId: addr.body.id, paymentMethod: method });
  expect(order.status).toBe(201);
  return { s, c, order: order.body };
}

describe('order documents', () => {
  it('shows an unpaid order as an invoice with the amount owing and where to pay, a paid one as a receipt', async () => {
    const r = await placed();
    const get = () => call(ctx.app, 'GET', `/shop/${r.s.slug}/me/orders/${r.order.orderNo}/document`, r.c.auth);
    const unpaid = (await get()).body;
    expect(unpaid).toMatchObject({
      orderNo: r.order.orderNo, status: 'pending_payment', currency: 'NGN', paymentMethod: 'bank_transfer',
      seller: { name: 'Test Shop', address: '12 Kwari Market, Kano', taxId: 'TIN-445566', footer: 'Goods once sold are not returnable uncut.' },
      buyer: { name: 'Amina Yusuf', phone: '+2348011111111', businessName: null },
      deliveryTo: { recipient: 'Amina Yusuf', city: 'Kano' },
      goodsMinor: 752608, deliveryFeeMinor: 100000, totalMinor: 852608, paidMinor: 0, balanceMinor: 852608, payments: [], refunds: [],
      bank: { bankName: 'Test Bank', accountNumber: '0123456789' },
    });
    expect(unpaid.lines).toEqual([expect.objectContaining({ quantity: '2', taxCode: expect.any(String), taxRatePct: '7.5', totalMinor: 752608 })]);
    expect(unpaid.taxSummary).toEqual([expect.objectContaining({ ratePct: '7.5', taxableMinor: 700100, taxMinor: 52508 })]);   // 2 × 3,500.50 = 7,001.00 net + 525.08 VAT
    expect(unpaid.taxSummary[0].taxableMinor + unpaid.taxSummary[0].taxMinor).toBe(unpaid.goodsMinor);

    await call(ctx.app, 'POST', `/v1/sales-orders/${r.order.id}/payments`, r.s.a, { method: 'bank_transfer', reference: `D-${uniq()}`, amountMinor: 852608 });
    const paid = (await get()).body;
    expect(paid).toMatchObject({ status: 'paid', paidMinor: 852608, balanceMinor: 0, bank: null, payments: [expect.objectContaining({ method: 'bank_transfer', amountMinor: 852608 })] });
  });

  it('is the buyer\'s alone, and the same for staff who may read orders', async () => {
    const r = await placed();
    const stranger = await shopper(`other-${uniq()}@example.test`);
    await call(ctx.app, 'POST', `/shop/${r.s.slug}/me`, stranger.auth, { fullName: 'Someone Else' });
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/orders/${r.order.orderNo}/document`, stranger.auth)).status).toBe(404);
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/orders/${r.order.orderNo}/document`, undefined)).status).toBe(401);
    const desk = await call(ctx.app, 'GET', `/v1/sales-orders/${r.order.id}/document`, r.s.a);
    expect(desk.body).toMatchObject({ orderNo: r.order.orderNo, totalMinor: 852608, buyer: { email: r.c.email } });
    const reader = await staff(ctx.app, r.s.a, ['orders.read'], { type: 'legal_entity', id: r.s.w.ng });
    expect((await call(ctx.app, 'GET', `/v1/sales-orders/${r.order.id}/document`, reader.auth)).status).toBe(200);
    const nobody = await staff(ctx.app, r.s.a, ['catalog.read'], { type: 'legal_entity', id: r.s.w.ng });
    expect((await call(ctx.app, 'GET', `/v1/sales-orders/${r.order.id}/document`, nobody.auth)).status).toBe(403);
  });

  it('shows a cancelled order as owing nothing, and a refund as money paid back', async () => {
    const r = await placed();
    await call(ctx.app, 'POST', `/v1/sales-orders/${r.order.id}/payments`, r.s.a, { method: 'bank_transfer', reference: `D-${uniq()}`, amountMinor: 852608 });
    const maker = await staff(ctx.app, r.s.a, ['orders.read', 'orders.refund'], { type: 'legal_entity', id: r.s.w.ng });
    const refund = await call(ctx.app, 'POST', `/v1/sales-orders/${r.order.id}/refunds`, { ...maker.auth, 'idempotency-key': crypto.randomUUID() }, { amountMinor: 100000, method: 'bank_transfer', reason: 'Goods returned damaged' });
    expect(refund.status).toBe(201);
    const checker = await staff(ctx.app, r.s.a, ['orders.read', 'orders.refund.approve'], { type: 'legal_entity', id: r.s.w.ng });
    await call(ctx.app, 'POST', `/v1/refunds/${refund.body.id}/decision`, { ...checker.auth, 'idempotency-key': crypto.randomUUID() }, { decision: 'approve' });
    await call(ctx.app, 'POST', `/v1/refunds/${refund.body.id}/paid`, { ...checker.auth, 'idempotency-key': crypto.randomUUID() }, { payoutRef: 'BANK-1' });
    const doc = (await call(ctx.app, 'GET', `/v1/sales-orders/${r.order.id}/document`, r.s.a)).body;
    expect(doc.refunds).toEqual([expect.objectContaining({ amountMinor: 100000, method: 'bank_transfer' })]);
    expect(doc.refundedMinor).toBe(100000);

    const cancelled = await placed();
    await call(ctx.app, 'POST', `/shop/${cancelled.s.slug}/me/orders/${cancelled.order.orderNo}/cancel`, cancelled.c.auth);
    expect((await call(ctx.app, 'GET', `/shop/${cancelled.s.slug}/me/orders/${cancelled.order.orderNo}/document`, cancelled.c.auth)).body).toMatchObject({ status: 'cancelled', balanceMinor: 0, bank: null });
  });

  it('names the business and its tax number for a trade buyer, with the payment due date for an order on account', async () => {
    const r = await placed();
    const list = await call(ctx.app, 'POST', '/v1/pricing/price-lists', r.s.a, { legalEntityId: r.s.w.ng, name: 'Wholesale NGN', currency: 'NGN' });
    await call(ctx.app, 'PUT', `/v1/pricing/price-lists/${list.body.id}/items`, r.s.a, { variantId: r.s.w.fabric.variantId, unitPrice: '3000', taxCodeId: r.s.w.vat });
    await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/trade`, r.c.auth, { businessName: 'Amina Fabrics', taxId: 'TIN-998877' });
    const queue = await call(ctx.app, 'GET', '/v1/trade-accounts', r.s.a);
    const tradeId = queue.body.find((t: any) => t.email === r.c.email).id;
    await call(ctx.app, 'POST', `/v1/trade-accounts/${tradeId}/decision`, r.s.a, { status: 'approved', priceListId: list.body.id, creditLimitMinor: 50_000_000, paymentTermsDays: 30 });
    const addr = (await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/addresses`, r.c.auth)).body[0].id;
    const o = await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders`, { ...r.c.auth, 'idempotency-key': crypto.randomUUID() }, { lines: [{ variantId: r.s.w.fabric.variantId, quantity: '10' }], addressId: addr, paymentMethod: 'account' });
    const doc = (await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/orders/${o.body.orderNo}/document`, r.c.auth)).body;
    expect(doc).toMatchObject({ paymentMethod: 'account', buyer: { businessName: 'Amina Fabrics', taxId: 'TIN-998877' }, dueOn: o.body.dueOn, balanceMinor: o.body.totalMinor, bank: { accountNumber: '0123456789' } });
    expect(doc.dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
