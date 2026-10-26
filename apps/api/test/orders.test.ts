import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, staff } from './helpers.js';
import { balance, cmd, reconciled, receive } from './inventory-helpers.js';
import { goLive, shopper, shopWorld, uniq, type Shop } from './shop-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

/** A live store with delivery to Kano, a registered shopper and a saved address. */
async function ready() {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'Kano', countryCode: 'NG', states: ['Kano'], feeMinor: 150000, freeOverMinor: 100000000 });
  const c = await shopper(`o-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Amina Yusuf', phone: '+2348012345678' });
  const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'Home', recipient: 'Amina Yusuf', phone: '+2348012345678', line1: '12 Zoo Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
  return { s, c, addressId: addr.body.id as string };
}
const place = (r: Awaited<ReturnType<typeof ready>>, lines: unknown[], extra: Record<string, unknown> = {}, key = crypto.randomUUID()) =>
  call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders`, { ...r.c.auth, 'idempotency-key': key }, { lines, addressId: r.addressId, paymentMethod: 'bank_transfer', ...extra });
const fabric = (r: { s: Shop }) => balance(ctx.app, r.s.a, { locationId: r.s.w.shop, variantId: r.s.w.fabric.variantId });

describe('placing an order', () => {
  it('prices on the server, reserves stock, numbers the order and holds the delivery fee', async () => {
    const r = await ready();
    const before = await fabric(r);
    expect(before.available).toBe('100');
    const o = await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '2.5' }]);
    expect(o.status).toBe(201);
    // 2.5 m x 3,500.50 = 8,751.25 + 7.5% VAT 656.34 = 9,407.59 ; + 1,500.00 delivery
    expect(o.body).toMatchObject({ status: 'pending_payment', orderNo: 'SO-000001', subtotalMinor: 940759, deliveryFeeMinor: 150000, totalMinor: 1090759, paymentMethod: 'bank_transfer' });
    expect(o.body.lines[0]).toMatchObject({ quantity: '2.5', unitPrice: '3500.5', totalMinor: 940759 });
    expect(o.body.delivery).toMatchObject({ city: 'Kano', zone: 'Kano' });
    expect(o.body.contact).toMatchObject({ name: 'Amina Yusuf' });
    const after = await fabric(r);
    expect(after).toMatchObject({ quantity: '100', reserved: '2.5', available: '97.5' });
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/products/ankara-wax`, undefined)).body.variants[0].available).toBe(97.5);
    expect(await reconciled(ctx.app, r.s.a)).toMatchObject({ consistent: true });
    // the second order gets the next number
    const o2 = await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '1' }]);
    expect(o2.body.orderNo).toBe('SO-000002');
  });

  it('ignores any price or total the client tries to send', async () => {
    const r = await ready();
    const o = await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '1', unitPrice: '1', totalMinor: 1 } as never], { totalMinor: 1, deliveryFeeMinor: 0 });
    expect(o.status).toBe(201);
    expect(o.body.totalMinor).toBe(376304 + 150000);
  });

  it('replays the same Idempotency-Key once and refuses it for a different basket', async () => {
    const r = await ready();
    const key = crypto.randomUUID();
    const lines = [{ variantId: r.s.w.fabric.variantId, quantity: '3' }];
    const a = await place(r, lines, {}, key);
    const b = await place(r, lines, {}, key);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect((await fabric(r)).reserved).toBe('3');
    expect((await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '4' }], {}, key)).status).toBe(422);
    const noKey = await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders`, r.c.auth, { lines, addressId: r.addressId, paymentMethod: 'card' });
    expect(noKey.status).toBe(400);
  });

  it('refuses more than is available, reporting each shortage, and reserves nothing', async () => {
    const r = await ready();
    const o = await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '100.01' }]);
    expect(o.status).toBe(409);
    expect(o.body).toMatchObject({ error: 'shortage', details: [expect.objectContaining({ requested: '100.01', available: '100' })] });
    expect((await fabric(r)).reserved).toBe('0');
  });

  it('only two of three shoppers racing for the last stock can get it', async () => {
    const r = await ready();
    const others = await Promise.all([0, 1].map(async () => {
      const c = await shopper(`race-${uniq()}@example.test`);
      await call(ctx.app, 'POST', `/shop/${r.s.slug}/me`, c.auth, { fullName: 'Racer One' });
      const a = await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Racer One', phone: '+2348000000001', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
      return { c, addressId: a.body.id as string };
    }));
    const results = await Promise.all([{ c: r.c, addressId: r.addressId }, ...others].map((x) =>
      place({ ...r, ...x }, [{ variantId: r.s.w.fabric.variantId, quantity: '40' }])));
    expect(results.map((x) => x.status).sort()).toEqual([201, 201, 409]);
    expect((await fabric(r))).toMatchObject({ reserved: '80', available: '20' });
  });

  it('rejects unpublished products, other people\'s addresses, duplicate lines and wrong quantity precision', async () => {
    const r = await ready();
    // the lotted product is not published
    expect((await place(r, [{ variantId: r.s.w.lotted.variantId, quantity: '1' }])).status).toBe(422);
    const dup = [{ variantId: r.s.w.fabric.variantId, quantity: '1' }, { variantId: r.s.w.fabric.variantId, quantity: '2' }];
    expect((await place(r, dup)).status).toBe(422);
    expect((await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '1.005' }])).status).toBe(422);
    expect((await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '0' }])).status).toBe(422);
    const other = await ready();
    expect((await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '1' }], { addressId: other.addressId })).status).toBe(422);
    // no delivery zone for the address's state
    const far = await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/addresses`, r.c.auth, { label: 'Abroad', recipient: 'Amina Yusuf', phone: '+2348012345678', line1: '1 Rue', city: 'Accra', state: 'Accra', countryCode: 'GH' });
    expect((await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '1' }], { addressId: far.body.id })).status).toBe(422);
  });

  it('allocates a roll-tracked product from released rolls only, oldest first', async () => {
    const r = await ready();
    const { s } = r;
    await receive(ctx.app, s.a, s.w.shop, s.w.rolled.variantId, '30', { lotCode: 'ROLL-A' });
    const rollB = await receive(ctx.app, s.a, s.w.shop, s.w.rolled.variantId, '30', { lotCode: 'ROLL-B' });
    await s.publish(s.w.rolled.productId, { slug: 'rolled', title: 'Rolled', published: true });
    await cmd(ctx.app, s.a, `/v1/quality/lots/${rollB.lines[0]!.lotId}/hold`, { reason: 'Colour fading suspected' });
    const o = await place(r, [{ variantId: s.w.rolled.variantId, quantity: '20' }]);
    expect(o.status).toBe(201);
    const lots = await call(ctx.app, 'GET', '/v1/inventory/lots', s.a);
    expect(lots.body.find((l: any) => l.code === 'ROLL-A')).toBeTruthy();
    expect((await place(r, [{ variantId: s.w.rolled.variantId, quantity: '20' }])).status).toBe(409); // only 10 left in ROLL-A
    // shipping later issues from ROLL-A
    await call(ctx.app, 'POST', `/v1/sales-orders/${o.body.id}/payments`, s.a, { method: 'bank_transfer', reference: `TRF-${uniq()}`, amountMinor: o.body.totalMinor });
    const shipped = await call(ctx.app, 'POST', `/v1/sales-orders/${o.body.id}/steps`, s.a, { action: 'ship' });
    expect(shipped.body.status).toBe('shipped');
    const bal = await call(ctx.app, 'GET', `/v1/inventory/balances?locationId=${s.w.shop}&variantId=${s.w.rolled.variantId}`, s.a);
    expect(bal.body.find((b: any) => b.lotCode === 'ROLL-A')).toMatchObject({ quantity: '10', reserved: '0' });
  });
});

describe('the order lifecycle', () => {
  it('goes from payment to delivery, issuing stock at shipment and keeping an event trail', async () => {
    const r = await ready();
    const o = await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '10' }]);
    const id = o.body.id as string;
    const a = r.s.a;
    const pay = (body: Record<string, unknown>) => call(ctx.app, 'POST', `/v1/sales-orders/${id}/payments`, a, body);
    expect((await call(ctx.app, 'POST', `/v1/sales-orders/${id}/steps`, a, { action: 'ship' })).status).toBe(409); // not paid
    expect((await pay({ method: 'bank_transfer', reference: 'TRF-0001', amountMinor: 1 })).status).toBe(422);
    const paid = await pay({ method: 'bank_transfer', reference: `TRF-${uniq()}`, amountMinor: o.body.totalMinor });
    expect(paid.body).toMatchObject({ status: 'paid', paidMinor: o.body.totalMinor });
    expect((await pay({ method: 'bank_transfer', reference: 'TRF-9999', amountMinor: o.body.totalMinor })).status).toBe(409); // not awaiting payment any more
    expect((await call(ctx.app, 'POST', `/v1/sales-orders/${id}/steps`, a, { action: 'process' })).body.status).toBe('processing');
    expect((await fabric(r))).toMatchObject({ quantity: '100', reserved: '10' });
    const shipped = await call(ctx.app, 'POST', `/v1/sales-orders/${id}/steps`, a, { action: 'ship', carrier: 'GIG Logistics', trackingRef: 'GIG123' });
    expect(shipped.body).toMatchObject({ status: 'shipped', carrier: 'GIG Logistics', trackingRef: 'GIG123' });
    expect((await fabric(r))).toMatchObject({ quantity: '90', reserved: '0' });
    expect((await call(ctx.app, 'POST', `/v1/sales-orders/${id}/cancel`, a, { reason: 'Changed my mind' })).status).toBe(409);
    const done = await call(ctx.app, 'POST', `/v1/sales-orders/${id}/steps`, a, { action: 'deliver' });
    expect(done.body.status).toBe('delivered');
    expect(done.body.events.map((e: any) => e.status)).toEqual(['pending_payment', 'paid', 'processing', 'shipped', 'delivered']);
    expect(done.body.payments).toHaveLength(1);
    expect(await reconciled(ctx.app, a)).toMatchObject({ consistent: true });
    // the shopper sees the same trail
    const mine = await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/orders/${o.body.orderNo}`, r.c.auth);
    expect(mine.body).toMatchObject({ status: 'delivered', trackingRef: 'GIG123' });
    expect(mine.body.payments).toBeUndefined();
    const list = await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/orders`, r.c.auth);
    expect(list.body).toEqual([expect.objectContaining({ orderNo: o.body.orderNo, status: 'delivered', lineCount: 1 })]);
  });

  it('a payment reference settles only one order', async () => {
    const r = await ready();
    const o1 = await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '1' }]);
    const o2 = await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '1' }]);
    expect((await call(ctx.app, 'POST', `/v1/sales-orders/${o1.body.id}/payments`, r.s.a, { method: 'bank_transfer', reference: 'SAME-REF', amountMinor: o1.body.totalMinor })).status).toBe(200);
    expect((await call(ctx.app, 'POST', `/v1/sales-orders/${o2.body.id}/payments`, r.s.a, { method: 'bank_transfer', reference: 'SAME-REF', amountMinor: o2.body.totalMinor })).status).toBe(409);
  });

  it('lets a shopper cancel an unpaid order, freeing the stock, but not a paid one', async () => {
    const r = await ready();
    const o = await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '5' }]);
    const cancel = await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders/${o.body.orderNo}/cancel`, r.c.auth);
    expect(cancel.body).toMatchObject({ status: 'cancelled' });
    expect((await fabric(r)).reserved).toBe('0');
    expect((await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders/${o.body.orderNo}/cancel`, r.c.auth)).status).toBe(409);

    const o2 = await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '5' }]);
    await call(ctx.app, 'POST', `/v1/sales-orders/${o2.body.id}/payments`, r.s.a, { method: 'bank_transfer', reference: `TRF-${uniq()}`, amountMinor: o2.body.totalMinor });
    expect((await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders/${o2.body.orderNo}/cancel`, r.c.auth)).status).toBe(409);
    // staff can cancel a paid order before it ships, which records the refund owed
    const staffCancel = await call(ctx.app, 'POST', `/v1/sales-orders/${o2.body.id}/cancel`, r.s.a, { reason: 'Out of agreement on size' });
    expect(staffCancel.body).toMatchObject({ status: 'cancelled', refundDueMinor: o2.body.totalMinor, cancelReason: 'Out of agreement on size' });
    expect((await fabric(r)).reserved).toBe('0');
  });

  it('expires unpaid orders after the hold and returns the stock', async () => {
    const r = await ready();
    const o = await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '7' }], { paymentMethod: 'card' });
    expect(new Date(o.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    await ctx.db.query(`UPDATE sales_orders SET expires_at = now() - interval '1 minute' WHERE id = $1`, [o.body.id]);
    // the next checkout sweeps expired holds first
    const next = await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '1' }]);
    expect(next.status).toBe(201);
    const mine = await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/orders/${o.body.orderNo}`, r.c.auth);
    expect(mine.body.status).toBe('expired');
    expect((await fabric(r)).reserved).toBe('1');
    // a payment arriving for an expired order is refused rather than silently lost
    expect((await call(ctx.app, 'POST', `/v1/sales-orders/${o.body.id}/payments`, r.s.a, { method: 'card', reference: `PAY-${uniq()}`, amountMinor: o.body.totalMinor })).status).toBe(409);
  });
});

describe('who can see and do what', () => {
  it('keeps one shopper\'s orders from another and staff to their legal entity', async () => {
    const r = await ready();
    const o = await place(r, [{ variantId: r.s.w.fabric.variantId, quantity: '1' }]);
    const other = await shopper(`x-${uniq()}@example.test`);
    await call(ctx.app, 'POST', `/shop/${r.s.slug}/me`, other.auth, { fullName: 'Other Person' });
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/orders/${o.body.orderNo}`, other.auth)).status).toBe(404);
    expect((await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders/${o.body.orderNo}/cancel`, other.auth)).status).toBe(404);
    expect((await call(ctx.app, 'GET', `/v1/sales-orders/${o.body.id}`, other.auth)).status).toBe(401);

    const desk = await staff(ctx.app, r.s.a, ['orders.read'], { type: 'legal_entity', id: r.s.w.ng });
    expect((await call(ctx.app, 'GET', `/v1/sales-orders/${o.body.id}`, desk.auth)).body.orderNo).toBe(o.body.orderNo);
    expect((await call(ctx.app, 'POST', `/v1/sales-orders/${o.body.id}/payments`, desk.auth, { method: 'bank_transfer', reference: 'DESK-REF', amountMinor: o.body.totalMinor })).status).toBe(403);
    expect((await call(ctx.app, 'POST', `/v1/sales-orders/${o.body.id}/cancel`, desk.auth, { reason: 'No permission here' })).status).toBe(403);
    const ghDesk = await staff(ctx.app, r.s.a, ['orders.read'], { type: 'legal_entity', id: r.s.w.gh });
    expect((await call(ctx.app, 'GET', `/v1/sales-orders/${o.body.id}`, ghDesk.auth)).status).toBe(403);
    expect((await call(ctx.app, 'GET', '/v1/sales-orders', ghDesk.auth)).body.items).toEqual([]);
    const list = await call(ctx.app, 'GET', `/v1/sales-orders?status=pending_payment&q=${encodeURIComponent('amina')}`, desk.auth);
    expect(list.body.items).toEqual([expect.objectContaining({ orderNo: o.body.orderNo, customerName: 'Amina Yusuf' })]);
    expect((await call(ctx.app, 'GET', '/v1/sales-orders?q=zzz', desk.auth)).body.total).toBe(0);
  });
});
