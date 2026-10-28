import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeOrder } from '../src/shop/routing.js';
import { call, setupApp } from './helpers.js';
import { receive } from './inventory-helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

const A = 'a0000000-0000-4000-8000-000000000001', B = 'b0000000-0000-4000-8000-000000000002', C = 'c0000000-0000-4000-8000-000000000003';

describe('routeOrder', () => {
  const area = (locationId: string, states: string[] = [], priority = 100, countryCode = 'NG') => ({ locationId, countryCode, states, priority });
  it('keeps the listed order when nothing is configured', () => {
    expect(routeOrder([A, B, C], [], 'NG', 'Kano')).toEqual([A, B, C]);
  });
  it('puts locations that name the state first, then whole-country ones, then the rest', () => {
    expect(routeOrder([A, B, C], [area(B, ['kano', 'kaduna']), area(C)], 'NG', ' Kano ')).toEqual([B, C, A]);
    expect(routeOrder([A, B, C], [area(B, ['kano']), area(C)], 'NG', 'Lagos')).toEqual([C, A, B]);
  });
  it('orders equally good locations by priority, then by the listed order', () => {
    expect(routeOrder([A, B, C], [area(A, [], 50), area(B, [], 10), area(C, [], 10)], 'NG', 'Kano')).toEqual([B, C, A]);
  });
  it('ignores other countries and locations the store does not use', () => {
    expect(routeOrder([A, B], [area(B, [], 1, 'GH'), area(C, [], 1)], 'NG', 'Kano')).toEqual([A, B]);
  });
});

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

async function world() {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { contact: { bankName: 'Test Bank', accountName: 'Textiles Ltd', accountNumber: '0123456789' }, stockLocationIds: [s.w.shop, s.w.w1, s.w.w2] });
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  const c = await shopper(`route-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Amina Yusuf', phone: '+2348011111111' });
  const address = async (state: string) => (await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: state, recipient: 'Amina Yusuf', phone: '+2348011111111', line1: '1 Road', city: state, state, countryCode: 'NG' })).body.id as string;
  return { s, c, address };
}
type W = Awaited<ReturnType<typeof world>>;

const place = async (w: W, addressId: string, quantity: string) => {
  const r = await call(ctx.app, 'POST', `/shop/${w.s.slug}/me/orders`, { ...w.c.auth, 'idempotency-key': crypto.randomUUID() }, { lines: [{ variantId: w.s.w.fabric.variantId, quantity }], addressId, paymentMethod: 'bank_transfer' });
  return r;
};
const shipFrom = async (w: W, id: string) => (await call(ctx.app, 'GET', `/v1/sales-orders/${id}`, w.s.a)).body.shipFrom as string[];

describe('sending online orders from the nearest shop', () => {
  it('sends from the location that serves the customer\'s state, and falls back when it cannot supply the whole order', async () => {
    const w = await world();
    // The shop already holds 100 m. W1 serves Kano, W2 serves Lagos.
    await receive(ctx.app, w.s.a, w.s.w.w1, w.s.w.fabric.variantId, '10');
    await receive(ctx.app, w.s.a, w.s.w.w2, w.s.w.fabric.variantId, '10');
    const put = await call(ctx.app, 'PUT', `/v1/storefronts/${w.s.id}/fulfilment-areas`, w.s.a, { areas: [
      { locationId: w.s.w.w1, countryCode: 'ng', states: ['Kano', 'Kaduna'] },
      { locationId: w.s.w.w2, countryCode: 'NG', states: ['Lagos'] },
    ] });
    expect(put.status).toBe(200);
    expect(put.body).toEqual([expect.objectContaining({ locationName: 'W1', countryCode: 'NG', states: ['kano', 'kaduna'] }), expect.objectContaining({ locationName: 'W2', states: ['lagos'] })]);

    const kano = await place(w, await w.address('Kano'), '4');
    expect(kano.status).toBe(201);
    expect(await shipFrom(w, kano.body.id)).toEqual(['W1']);
    const lagos = await place(w, await w.address('Lagos'), '3');
    expect(await shipFrom(w, lagos.body.id)).toEqual(['W2']);

    // Kano's location has 6 m left: a bigger order comes whole from the next location that has it all (the shop), not split.
    const big = await place(w, await w.address('Kano'), '8');
    expect(await shipFrom(w, big.body.id)).toEqual(['Shop']);

    // A state nobody is named for goes from the first-listed location, as before.
    const other = await place(w, await w.address('Abuja'), '2');
    expect(await shipFrom(w, other.body.id)).toEqual(['Shop']);
  });

  it('splits across locations only when no single one can supply the whole order, taking the serving one first', async () => {
    const w = await world();
    await ctx.db.query(`UPDATE stock_balances SET quantity = 5 WHERE location_id = $1 AND variant_id = $2`, [w.s.w.shop, w.s.w.fabric.variantId]);
    await receive(ctx.app, w.s.a, w.s.w.w1, w.s.w.fabric.variantId, '5');
    await call(ctx.app, 'PUT', `/v1/storefronts/${w.s.id}/fulfilment-areas`, w.s.a, { areas: [{ locationId: w.s.w.w1, countryCode: 'NG', states: ['kano'] }] });
    const o = await place(w, await w.address('Kano'), '8');
    expect(o.status).toBe(201);
    expect(await shipFrom(w, o.body.id)).toEqual(['Shop', 'W1']);
    const reserved = await ctx.db.query(`SELECT l.name, r.quantity::text FROM stock_reservations r JOIN locations l ON l.id = r.location_id WHERE r.reference_id = $1 ORDER BY l.name`, [o.body.id]);
    expect(reserved.rows).toEqual([{ name: 'Shop', quantity: '3.000000' }, { name: 'W1', quantity: '5.000000' }]);
    // and still refuses when the group together does not have enough
    expect((await place(w, await w.address('Kano'), '500')).status).toBe(409);
  });

  it('checks that areas name this store\'s locations and are for staff who manage the store', async () => {
    const w = await world();
    const bad = await call(ctx.app, 'PUT', `/v1/storefronts/${w.s.id}/fulfilment-areas`, w.s.a, { areas: [{ locationId: w.s.w.g1, countryCode: 'NG' }] });
    expect(bad.status).toBe(422);
    const dup = await call(ctx.app, 'PUT', `/v1/storefronts/${w.s.id}/fulfilment-areas`, w.s.a, { areas: [{ locationId: w.s.w.w1, countryCode: 'NG' }, { locationId: w.s.w.w1, countryCode: 'NG', states: ['kano'] }] });
    expect(dup.status).toBe(422);
    expect((await call(ctx.app, 'PUT', `/v1/storefronts/${w.s.id}/fulfilment-areas`, w.s.a, { areas: [{ locationId: w.s.w.w1, countryCode: 'NG' }] })).status).toBe(200);
    expect((await call(ctx.app, 'PUT', `/v1/storefronts/${w.s.id}/fulfilment-areas`, w.s.a, { areas: [] })).body).toEqual([]);
  });
});
