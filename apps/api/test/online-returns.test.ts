import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/events/dispatcher.js';
import type { Mail, Mailer } from '../src/notify/mailer.js';
import { returnEmailConsumer } from '../src/notify/return-emails.js';
import { returnValue } from '../src/shop/returns.js';
import { balance } from './inventory-helpers.js';
import { call, setupApp, staff } from './helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

describe('returnValue', () => {
  it('is each line\'s total pro rata to the quantity, rounded half up, summed', () => {
    expect(returnValue([{ total: 752608n, ordered: '2', returned: '1' }])).toBe(376304n);
    expect(returnValue([{ total: 1001n, ordered: '2', returned: '1' }])).toBe(501n);
    expect(returnValue([{ total: 1000n, ordered: '3', returned: '1' }, { total: 500n, ordered: '1', returned: '1' }])).toBe(833n);
    expect(returnValue([{ total: 3225n, ordered: '3', returned: '3' }])).toBe(3225n);
  });
});

async function delivered() {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { contact: { bankName: 'Test Bank', accountName: 'Textiles Ltd', accountNumber: '0123456789', address: '12 Kwari Market, Kano' } });
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  const c = await shopper(`ret-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Amina Yusuf', phone: '+2348011111111' });
  const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Amina Yusuf', phone: '+2348011111111', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
  const o = await call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...c.auth, 'idempotency-key': crypto.randomUUID() }, { lines: [{ variantId: s.w.fabric.variantId, quantity: '2' }], addressId: addr.body.id, paymentMethod: 'bank_transfer' });
  expect(o.status).toBe(201);
  const pay = await call(ctx.app, 'POST', `/v1/sales-orders/${o.body.id}/payments`, s.a, { method: 'bank_transfer', reference: `RT-${uniq()}`, amountMinor: o.body.totalMinor });
  expect(pay.status).toBe(200);
  return { s, c, order: o.body as { id: string; orderNo: string; totalMinor: number } };
}
type D = Awaited<ReturnType<typeof delivered>>;
const deliver = async (d: D) => {
  await call(ctx.app, 'POST', `/v1/sales-orders/${d.order.id}/steps`, d.s.a, { action: 'ship' });
  expect((await call(ctx.app, 'POST', `/v1/sales-orders/${d.order.id}/steps`, d.s.a, { action: 'deliver' })).status).toBe(200);
};
const ask = (d: D, body: unknown, key = crypto.randomUUID(), auth = d.c.auth) =>
  call(ctx.app, 'POST', `/shop/${d.s.slug}/me/orders/${d.order.orderNo}/returns`, { ...auth, 'idempotency-key': key }, body);
const one = { reason: 'damaged', note: 'Cut in the middle', lines: [{ lineNo: 1, quantity: '1' }] };

describe('returns from online orders', () => {
  it('only after delivery, only within the window, never more than was bought, and only by the buyer', async () => {
    const d = await delivered();
    expect((await ask(d, one)).status).toBe(409);   // not delivered yet
    await deliver(d);
    const key = crypto.randomUUID();
    const first = await ask(d, one, key);
    expect(first.status).toBe(201);
    expect(first.body.returns).toEqual([expect.objectContaining({ status: 'requested', reason: 'damaged', note: 'Cut in the middle', lines: [expect.objectContaining({ lineNo: 1, quantity: '1' })] })]);
    // the same tap twice is one request
    const again = await ask(d, one, key);
    expect(again.status).toBe(200);
    expect(again.body.returns).toHaveLength(1);
    expect((await ask(d, { ...one, lines: [{ lineNo: 1, quantity: '2' }] }, key)).status).toBe(422);   // same key, different request
    // one metre is still open, the second may be asked for; a third may not
    expect((await ask(d, one)).status).toBe(201);
    expect((await ask(d, one)).status).toBe(422);
    expect((await ask(d, { ...one, lines: [{ lineNo: 9, quantity: '1' }] })).status).toBe(422);
    expect((await ask(d, { ...one, lines: [{ lineNo: 1, quantity: '0' }] })).status).toBe(422);

    const stranger = await shopper(`other-${uniq()}@example.test`);
    await call(ctx.app, 'POST', `/shop/${d.s.slug}/me`, stranger.auth, { fullName: 'Someone Else' });
    expect((await ask(d, one, crypto.randomUUID(), stranger.auth)).status).toBe(404);

    const late = await delivered();
    await deliver(late);
    await ctx.db.query(`UPDATE sales_orders SET delivered_at = now() - interval '3 days' WHERE id = $1`, [late.order.id]);
    const closed = await ask(late, one);
    expect(closed.status).toBe(409);
    expect(closed.body.message).toContain('48 hours');
    // staff can widen the window, or switch returns off
    await call(ctx.app, 'PUT', `/v1/storefronts/${late.s.id}`, late.s.a, { returnWindowHours: 168 });
    expect((await ask(late, one)).status).toBe(201);
    await call(ctx.app, 'PUT', `/v1/storefronts/${late.s.id}`, late.s.a, { returnWindowHours: 0 });
    expect((await ask(late, { ...one, lines: [{ lineNo: 1, quantity: '1' }] })).status).toBe(409);
  });

  it('lets the buyer withdraw a request, and a withdrawn request no longer holds the quantity', async () => {
    const d = await delivered(); await deliver(d);
    const r = await ask(d, { ...one, lines: [{ lineNo: 1, quantity: '2' }] });
    const id = r.body.returns[0].id;
    expect((await ask(d, one)).status).toBe(422);
    expect((await call(ctx.app, 'POST', `/shop/${d.s.slug}/me/returns/${id}/cancel`, d.c.auth)).status).toBe(200);
    expect((await call(ctx.app, 'POST', `/shop/${d.s.slug}/me/returns/${id}/cancel`, d.c.auth)).status).toBe(409);
    expect((await ask(d, { ...one, lines: [{ lineNo: 1, quantity: '2' }] })).status).toBe(201);
  });

  it('is decided by staff: approval raises a refund for the value of the goods that someone else must approve; a decline needs a reason', async () => {
    const d = await delivered(); await deliver(d);
    const ret = (await ask(d, one)).body.returns[0];
    const clerk = await staff(ctx.app, d.s.a, ['orders.refund', 'orders.read'], { type: 'legal_entity', id: d.s.w.ng });
    const nobody = await staff(ctx.app, d.s.a, ['orders.read'], { type: 'legal_entity', id: d.s.w.ng });
    expect((await call(ctx.app, 'POST', `/v1/order-returns/${ret.id}/decision`, nobody.auth, { decision: 'approve' })).status).toBe(403);
    expect((await call(ctx.app, 'POST', `/v1/order-returns/${ret.id}/decision`, clerk.auth, { decision: 'reject' })).status).toBe(422);

    const queue = await call(ctx.app, 'GET', '/v1/order-returns?status=requested', clerk.auth);
    expect(queue.body).toEqual([expect.objectContaining({ id: ret.id, orderNo: d.order.orderNo, customerName: 'Amina Yusuf', lines: [expect.objectContaining({ quantity: '1' })] })]);

    const ok = await call(ctx.app, 'POST', `/v1/order-returns/${ret.id}/decision`, clerk.auth, { decision: 'approve', note: 'Sorry about that' });
    expect(ok.status).toBe(200);
    expect(ok.body.refundMinor).toBe(376304);
    const order = (await call(ctx.app, 'GET', `/v1/sales-orders/${d.order.id}`, d.s.a)).body;
    expect(order.refunds).toEqual([expect.objectContaining({ amountMinor: 376304, status: 'requested', requestedBy: clerk.userId })]);
    expect(order.returns[0]).toMatchObject({ status: 'approved', refundMinor: 376304, decisionNote: 'Sorry about that' });
    expect(order.events.map((e: { note: string }) => e.note).join('|')).toContain('Return approved');
    // the person who raised the refund cannot approve the money
    expect((await call(ctx.app, 'POST', `/v1/refunds/${order.refunds[0].id}/decision`, clerk.auth, { decision: 'approve' })).status).toBe(403);
    expect((await call(ctx.app, 'POST', `/v1/order-returns/${ret.id}/decision`, clerk.auth, { decision: 'approve' })).status).toBe(409);

    const other = (await ask(d, one)).body.returns[0];
    const no = await call(ctx.app, 'POST', `/v1/order-returns/${other.id}/decision`, clerk.auth, { decision: 'reject', note: 'Fabric was cut to your measure' });
    expect(no.status).toBe(200);
    expect((await call(ctx.app, 'GET', `/shop/${d.s.slug}/me/orders/${d.order.orderNo}`, d.c.auth)).body.returns.find((r: { id: string }) => r.id === other.id)).toMatchObject({ status: 'rejected', decisionNote: 'Fabric was cut to your measure' });
  });

  it('puts returned goods back on the shelf only when staff say so, once, and not rolls or lots', async () => {
    const d = await delivered(); await deliver(d);
    const ret = (await ask(d, one)).body.returns[0];
    const clerk = await staff(ctx.app, d.s.a, ['orders.refund', 'orders.fulfil', 'orders.read'], { type: 'legal_entity', id: d.s.w.ng });
    expect((await call(ctx.app, 'POST', `/v1/order-returns/${ret.id}/received`, clerk.auth, { locationId: d.s.w.shop, restockLines: [1] })).status).toBe(409);   // not approved yet
    await call(ctx.app, 'POST', `/v1/order-returns/${ret.id}/decision`, clerk.auth, { decision: 'approve' });
    const before = Number((await balance(ctx.app, d.s.a, { locationId: d.s.w.shop, variantId: d.s.w.fabric.variantId })).quantity);
    expect((await call(ctx.app, 'POST', `/v1/order-returns/${ret.id}/received`, clerk.auth, { locationId: d.s.w.shop, restockLines: [7] })).status).toBe(422);
    expect((await call(ctx.app, 'POST', `/v1/order-returns/${ret.id}/received`, clerk.auth, { locationId: d.s.w.shop, restockLines: [1] })).status).toBe(200);
    const after = Number((await balance(ctx.app, d.s.a, { locationId: d.s.w.shop, variantId: d.s.w.fabric.variantId })).quantity);
    expect(after - before).toBe(1);
    expect((await call(ctx.app, 'POST', `/v1/order-returns/${ret.id}/received`, clerk.auth, { locationId: d.s.w.shop, restockLines: [1] })).status).toBe(409);
    expect((await call(ctx.app, 'GET', `/v1/sales-orders/${d.order.id}/returns`, clerk.auth)).body[0]).toMatchObject({ status: 'received', lines: [{ restocked: true }] });

    // a damaged return is booked in without going back on the shelf
    const second = (await ask(d, one)).body.returns[0];
    await call(ctx.app, 'POST', `/v1/order-returns/${second.id}/decision`, clerk.auth, { decision: 'approve' });
    await call(ctx.app, 'POST', `/v1/order-returns/${second.id}/received`, clerk.auth, { locationId: d.s.w.shop, restockLines: [] });
    expect(Number((await balance(ctx.app, d.s.a, { locationId: d.s.w.shop, variantId: d.s.w.fabric.variantId })).quantity)).toBe(after);
  });

  it('tells the buyer what was decided, in their language, once', async () => {
    const d = await delivered(); await deliver(d);
    await ctx.db.query(`UPDATE customers SET language = 'fr' WHERE email = $1`, [d.c.email]);
    const sent: Mail[] = [];
    const mailer: Mailer = { async send(m) { sent.push(m); } };
    const dispatcher = new Dispatcher(ctx.db, { secretBox: null, urlPolicy: { allowHttp: false, allowPrivate: false }, consumers: [returnEmailConsumer(mailer)] });
    const drain = async () => { for (let i = 0; i < 2000; i++) if ((await dispatcher.runOnce(new Date(Date.now() + 3_600_000))) === 0) return; };
    const ret = (await ask(d, one)).body.returns[0];
    const clerk = await staff(ctx.app, d.s.a, ['orders.refund', 'orders.read'], { type: 'legal_entity', id: d.s.w.ng });
    await call(ctx.app, 'POST', `/v1/order-returns/${ret.id}/decision`, clerk.auth, { decision: 'approve' });
    await drain(); await drain();
    const mine = sent.filter((m) => m.to === d.c.email);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toBe(`Votre retour pour la commande ${d.order.orderNo} a été accepté`);
    expect(mine[0]!.text).toContain('remboursement');
    expect(mine[0]!.text).toContain('12 Kwari Market, Kano');
  });
});
