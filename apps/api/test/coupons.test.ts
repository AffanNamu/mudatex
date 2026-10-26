import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp } from './helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

async function ready() {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  const addr = async (c: Awaited<ReturnType<typeof shopper>>) => {
    await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Coupon User' });
    return (await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Coupon User', phone: '+2348011111111', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' })).body.id as string;
  };
  const c = await shopper(`cp-${uniq()}@example.test`);
  const addressId = await addr(c);
  const coupon = (body: Record<string, unknown>) => call(ctx.app, 'POST', `/v1/storefronts/${s.id}/coupons`, s.a, { code: `T${uniq().toUpperCase()}`, percentBps: 1000, ...body });
  const order = (who: { auth: any }, address: string, code?: string, qty = '2') =>
    call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...who.auth, 'idempotency-key': crypto.randomUUID() }, {
      lines: [{ variantId: s.w.fabric.variantId, quantity: qty }], addressId: address, paymentMethod: 'bank_transfer', ...(code ? { couponCode: code } : {}),
    });
  return { s, c, addressId, addr, coupon, order };
}

describe('coupons', () => {
  it('takes a percentage off every line, tax included, and shows the saving on the basket and the order', async () => {
    const r = await ready();
    const cp = await r.coupon({ code: 'WELCOME10', percentBps: 1000 });
    expect(cp.status).toBe(201);
    const line = { variantId: r.s.w.fabric.variantId, quantity: '2' };
    // 2 m x 3,500.50 = 7,001.00 ; 10% off = 6,300.90 ; + 7.5% VAT = 6,773.47 (rounded half up)
    const basket = await call(ctx.app, 'POST', `/shop/${r.s.slug}/basket`, undefined, { lines: [line], couponCode: 'welcome10' });
    expect(basket.body).toMatchObject({ coupon: { code: 'WELCOME10', percentBps: 1000 }, subtotalMinor: 677347, discountMinor: 70010 });
    const o = await r.order(r.c, r.addressId, 'welcome10');
    expect(o.status).toBe(201);
    expect(o.body).toMatchObject({ couponCode: 'WELCOME10', discountMinor: 70010, subtotalMinor: 677347, totalMinor: 777347 });
    expect(o.body.lines[0]).toMatchObject({ grossMinor: 700100, discountMinor: 70010, totalMinor: 677347 });
  });

  it('refuses unknown, inactive, early, expired and below-minimum coupons', async () => {
    const r = await ready();
    const line = [{ variantId: r.s.w.fabric.variantId, quantity: '1' }];
    const ask = (code: string) => call(ctx.app, 'POST', `/shop/${r.s.slug}/basket`, undefined, { lines: line, couponCode: code });
    expect((await ask('NOSUCH')).body.message).toMatch(/not valid/);
    await r.coupon({ code: 'OFF', percentBps: 500 });
    const list = await call(ctx.app, 'GET', `/v1/storefronts/${r.s.id}/coupons`, r.s.a);
    await call(ctx.app, 'PUT', `/v1/storefronts/${r.s.id}/coupons/${list.body[0].id}`, r.s.a, { active: false });
    expect((await ask('OFF')).status).toBe(422);
    await r.coupon({ code: 'LATER', startsAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect((await ask('LATER')).body.message).toMatch(/not active yet/);
    await r.coupon({ code: 'PAST', startsAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), endsAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect((await ask('PAST')).body.message).toMatch(/expired/);
    await r.coupon({ code: 'BIGSPEND', minSubtotalMinor: 100_000_000 });
    expect((await ask('BIGSPEND')).body.message).toMatch(/minimum/);
    expect((await r.coupon({ code: 'WELCOME10', percentBps: 10000 })).status).toBe(400);
  });

  it('limits uses per customer and in total, and frees a use when the order is cancelled', async () => {
    const r = await ready();
    await r.coupon({ code: 'ONCE', perCustomerLimit: 1, maxRedemptions: 2 });
    const first = await r.order(r.c, r.addressId, 'ONCE');
    expect(first.status).toBe(201);
    expect((await r.order(r.c, r.addressId, 'ONCE')).body.message).toMatch(/already used/);
    // a signed-in shopper is told at the basket, before checkout; an anonymous quote cannot know
    const line = [{ variantId: r.s.w.fabric.variantId, quantity: '1' }];
    expect((await call(ctx.app, 'POST', `/shop/${r.s.slug}/basket`, r.c.auth, { lines: line, couponCode: 'ONCE' })).body.message).toMatch(/already used/);
    expect((await call(ctx.app, 'POST', `/shop/${r.s.slug}/basket`, undefined, { lines: line, couponCode: 'ONCE' })).status).toBe(200);
    await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders/${first.body.orderNo}/cancel`, r.c.auth);
    expect((await r.order(r.c, r.addressId, 'ONCE')).status).toBe(201);

    const b = await shopper(`cpb-${uniq()}@example.test`);
    const c2 = await shopper(`cpc-${uniq()}@example.test`);
    const ab = await r.addr(b); const ac = await r.addr(c2);
    expect((await r.order(b, ab, 'ONCE')).status).toBe(201);
    expect((await r.order(c2, ac, 'ONCE')).body.message).toMatch(/fully used/);
    const used = await call(ctx.app, 'GET', `/v1/storefronts/${r.s.id}/coupons`, r.s.a);
    expect(used.body[0]).toMatchObject({ code: 'ONCE', timesUsed: 2 });
  });

  it('does not let two simultaneous checkouts both take the last use', async () => {
    const r = await ready();
    await r.coupon({ code: 'LAST1', maxRedemptions: 1 });
    const people = await Promise.all([0, 1, 2].map(async () => { const c = await shopper(`race-${uniq()}@example.test`); return { c, a: await r.addr(c) }; }));
    const results = await Promise.all(people.map((p) => r.order(p.c, p.a, 'LAST1', '1')));
    expect(results.map((x) => x.status).sort()).toEqual([201, 422, 422]);
  });

  it('keeps other stores\' coupons out of reach and lets staff manage only their own store\'s', async () => {
    const a = await ready();
    const b = await ready();
    await a.coupon({ code: 'ONLYA' });
    const res = await call(ctx.app, 'POST', `/shop/${b.s.slug}/basket`, undefined, { lines: [{ variantId: b.s.w.fabric.variantId, quantity: '1' }], couponCode: 'ONLYA' });
    expect(res.status).toBe(422);
    expect((await call(ctx.app, 'GET', `/v1/storefronts/${a.s.id}/coupons`, b.s.a)).status).toBe(404);
  });
});
