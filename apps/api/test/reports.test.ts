import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, staff } from './helpers.js';
import { cmd } from './inventory-helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';
import { cash, openSession, sell } from './pos-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

async function trading() {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  // till: two cash sales of Ankara-like fabric
  const session = await openSession(ctx.app, s.w.cashier.auth, s.w.reg1);
  const line = (q: string) => [{ variantId: s.w.fabric.variantId, quantity: q }];
  expect((await sell(ctx.app, s.w.cashier.auth, s.w.reg1, line('1'), [cash(376304)])).status).toBe(201);
  expect((await sell(ctx.app, s.w.cashier.auth, s.w.reg1, line('3'), [cash(1128911)])).status).toBe(201);
  // online: one paid and shipped order, one still awaiting payment
  const c = await shopper(`rp-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Report Buyer' });
  const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Report Buyer', phone: '+2348011111111', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
  const order = async (qty: string) => (await call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...c.auth, 'idempotency-key': crypto.randomUUID() }, { lines: [{ variantId: s.w.fabric.variantId, quantity: qty }], addressId: addr.body.id, paymentMethod: 'bank_transfer' })).body;
  const paid = await order('2');
  await call(ctx.app, 'POST', `/v1/sales-orders/${paid.id}/payments`, s.a, { method: 'bank_transfer', reference: `R-${uniq()}`, amountMinor: paid.totalMinor });
  const open = await order('1');
  return { s, session, paid, open, c };
}

describe('the overview report', () => {
  it('adds up each channel by day in its own currency, ranks products, and counts what needs attention', async () => {
    const t = await trading();
    const r = await call(ctx.app, 'GET', '/v1/reports/overview?days=7', t.s.a);
    expect(r.status).toBe(200);
    const ngn = r.body.sales.find((x: any) => x.currency === 'NGN');
    expect(ngn.minorUnit).toBe(2);
    // till: 1 m + 3 m with VAT; online: the paid 2 m order and its delivery. The unpaid order is not counted.
    expect(ngn.totals).toMatchObject({ pos: 376304 + 1128911, posSales: 2, onlineOrders: 1, online: t.paid.totalMinor });
    expect(ngn.series).toHaveLength(1);
    expect(ngn.series[0]).toMatchObject({ pos: 376304 + 1128911, online: t.paid.totalMinor });
    expect(ngn.topProducts[0]).toMatchObject({ name: 'Fabric', quantity: 6 }); // 1 + 3 sold at the till, 2 online
    expect(r.body.attention).toMatchObject({ ordersAwaitingPayment: 1, ordersToShip: 1, newEnquiries: 0, reviewsToApprove: 0, tradeApplications: 0, offlineShortfalls: 0 });
  });

  it('is limited to what the person may see: a cashier sees the till but not online orders', async () => {
    const t = await trading();
    const r = await call(ctx.app, 'GET', '/v1/reports/overview?days=7', t.s.w.cashier.auth);
    expect(r.status).toBe(200);
    const ngn = r.body.sales.find((x: any) => x.currency === 'NGN');
    expect(ngn.totals).toMatchObject({ pos: 376304 + 1128911, online: 0, onlineOrders: 0 });
    expect(r.body.attention.ordersToShip).toBeUndefined();
    const nobody = await staff(ctx.app, t.s.a, ['catalog.read'], { type: 'group' });
    const none = await call(ctx.app, 'GET', '/v1/reports/overview', nobody.auth);
    expect(none.body).toMatchObject({ sales: [], lowStock: [], attention: {} });
    const gh = await staff(ctx.app, t.s.a, ['pos.read', 'orders.read'], { type: 'legal_entity', id: t.s.w.gh });
    expect((await call(ctx.app, 'GET', '/v1/reports/overview', gh.auth)).body.sales).toEqual([]);
  });

  it('lists products that are selling but running low', async () => {
    const t = await trading();
    // stock was 100; leave 4 free
    await cmd(ctx.app, t.s.a, '/v1/inventory/issues', { locationId: t.s.w.shop, reasonCode: 'sample', lines: [{ variantId: t.s.w.fabric.variantId, quantity: '88.5' }] });
    const r = await call(ctx.app, 'GET', '/v1/reports/overview?lowStockAt=10', t.s.a);
    expect(r.body.lowStock).toEqual([expect.objectContaining({ name: 'Fabric', location: 'Shop', available: expect.any(Number) })]);
    expect(r.body.lowStock[0].available).toBeLessThanOrEqual(10);
    expect((await call(ctx.app, 'GET', '/v1/reports/overview?lowStockAt=0', t.s.a)).body.lowStock).toEqual([]);
  });

  it('rejects a silly period', async () => {
    const t = await trading();
    expect((await call(ctx.app, 'GET', '/v1/reports/overview?days=9999', t.s.a)).status).toBe(400);
  });
});
