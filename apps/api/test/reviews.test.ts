import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, staff } from './helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

async function ready() {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  const c = await shopper(`rv-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Amina Yusuf Bello' });
  const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Amina Yusuf', phone: '+2348011111111', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
  const order = await call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...c.auth, 'idempotency-key': crypto.randomUUID() }, {
    lines: [{ variantId: s.w.fabric.variantId, quantity: '1' }], addressId: addr.body.id, paymentMethod: 'bank_transfer',
  });
  if (order.status !== 201) throw new Error('order failed ' + JSON.stringify(order.body));
  const deliver = async () => {
    await call(ctx.app, 'POST', `/v1/sales-orders/${order.body.id}/payments`, s.a, { method: 'bank_transfer', reference: `R-${uniq()}`, amountMinor: order.body.totalMinor });
    await call(ctx.app, 'POST', `/v1/sales-orders/${order.body.id}/steps`, s.a, { action: 'ship' });
  };
  const review = (who = c, extra: Record<string, unknown> = {}) =>
    call(ctx.app, 'POST', `/shop/${s.slug}/me/reviews`, who.auth, { productSlug: 'ankara-wax', rating: 5, title: 'Lovely', body: 'The colours are exactly as pictured and the cloth is thick.', ...extra });
  return { s, c, order: order.body, deliver, review };
}

describe('reviews', () => {
  it('are for customers who have been sent the product, held until a person approves, then public with an average', async () => {
    const r = await ready();
    expect((await r.review()).status).toBe(403); // ordered but not yet shipped
    await r.deliver();
    const made = await r.review();
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.status).toBe('pending');

    // not public yet
    const pub = () => call(ctx.app, 'GET', `/shop/${r.s.slug}/products/ankara-wax/reviews`, undefined);
    expect((await pub()).body.total).toBe(0);
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/products/ankara-wax`, undefined)).body.rating).toEqual({ average: null, count: 0 });

    const queue = await call(ctx.app, 'GET', '/v1/reviews', r.s.a);
    expect(queue.body).toEqual([expect.objectContaining({ rating: 5, name: 'Amina B.', productTitle: 'Ankara Wax', status: 'pending' })]);
    expect((await call(ctx.app, 'POST', `/v1/reviews/${queue.body[0].id}/moderate`, r.s.a, { status: 'published' })).body.status).toBe('published');

    expect((await pub()).body).toMatchObject({ total: 1, items: [expect.objectContaining({ rating: 5, title: 'Lovely', name: 'Amina B.' })] });
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/products/ankara-wax`, undefined)).body.rating).toEqual({ average: 5, count: 1 });
    expect((await r.review()).status).toBe(409); // one review each
  });

  it('can be rejected, and rejected reviews never show', async () => {
    const r = await ready();
    await r.deliver();
    await r.review(r.c, { rating: 1, body: 'Rude words that should never be shown to anyone.' });
    const [q] = (await call(ctx.app, 'GET', '/v1/reviews', r.s.a)).body;
    await call(ctx.app, 'POST', `/v1/reviews/${q.id}/moderate`, r.s.a, { status: 'rejected' });
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/products/ankara-wax/reviews`, undefined)).body.total).toBe(0);
    expect((await call(ctx.app, 'GET', '/v1/reviews?status=rejected', r.s.a)).body).toHaveLength(1);
  });

  it('are checked: a real rating, a real comment, a product the customer was sent, and only staff may moderate', async () => {
    const r = await ready();
    await r.deliver();
    expect((await r.review(r.c, { rating: 6 })).status).toBe(400);
    expect((await r.review(r.c, { body: 'short' })).status).toBe(400);
    expect((await r.review(r.c, { productSlug: 'no-such-product' })).status).toBe(404);
    const stranger = await shopper(`st-${uniq()}@example.test`);
    await call(ctx.app, 'POST', `/shop/${r.s.slug}/me`, stranger.auth, { fullName: 'Stranger Danger' });
    expect((await r.review(stranger)).status).toBe(403); // never bought it
    await r.review();
    const [q] = (await call(ctx.app, 'GET', '/v1/reviews', r.s.a)).body;
    const nobody = await staff(ctx.app, r.s.a, ['catalog.read'], { type: 'group' });
    expect((await call(ctx.app, 'GET', '/v1/reviews', nobody.auth)).body).toEqual([]);
    expect((await call(ctx.app, 'POST', `/v1/reviews/${q.id}/moderate`, nobody.auth, { status: 'published' })).status).toBe(403);
    const gh = await staff(ctx.app, r.s.a, ['reviews.moderate'], { type: 'legal_entity', id: r.s.w.gh });
    expect((await call(ctx.app, 'POST', `/v1/reviews/${q.id}/moderate`, gh.auth, { status: 'published' })).status).toBe(403);
  });
});
