import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CarrierAdapter } from '../src/shipping/adapters.js';
import { pollShipments } from '../src/shipping/poll.js';
import { createSecretBox } from '../src/events/secretbox.js';
import { call, setupApp, staff } from './helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
let booked = 0;
let down = false;
const tracked = new Map<string, { status: string; description?: string; occurredAt?: string }[]>();
const fake: CarrierAdapter = {
  key: 'fakeexpress',
  async book(parcel, creds) {
    if (down) throw new Error('503 from the carrier');
    booked++;
    expect(creds.apiKey).toBe('k-123');
    return { trackingRef: `FX-${parcel.orderNo}`, externalId: `ext-${parcel.orderNo}`, labelUrl: 'https://carrier.example/label.pdf', eta: '2030-01-05' };
  },
  async track(s) { return { events: tracked.get(s.trackingRef) ?? [], eta: '2030-01-06' }; },
};

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => {
  ctx = await setupApp({ SECRETS_ENCRYPTION_KEY: KEY }, { carrierAdapters: { fakeexpress: fake } });
});
afterAll(async () => { await ctx.close(); });

async function world() {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { contact: { bankName: 'Test Bank', accountName: 'Textiles Ltd', accountNumber: '0123456789' } });
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  const c = await shopper(`ship-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Amina Yusuf', phone: '+2348011111111' });
  const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Amina Yusuf', phone: '+2348011111111', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
  return { s, c, addr: addr.body.id as string };
}
type World = Awaited<ReturnType<typeof world>>;

async function paidOrder(w: World) {
  const o = await call(ctx.app, 'POST', `/shop/${w.s.slug}/me/orders`, { ...w.c.auth, 'idempotency-key': crypto.randomUUID() }, { lines: [{ variantId: w.s.w.fabric.variantId, quantity: '1' }], addressId: w.addr, paymentMethod: 'bank_transfer' });
  expect(o.status).toBe(201);
  const pay = await call(ctx.app, 'POST', `/v1/sales-orders/${o.body.id}/payments`, w.s.a, { method: 'bank_transfer', reference: `SH-${uniq()}`, amountMinor: o.body.totalMinor });
  expect(pay.status).toBe(200);
  return o.body as { id: string; orderNo: string };
}
const detail = async (w: World, id: string) => (await call(ctx.app, 'GET', `/v1/sales-orders/${id}`, w.s.a)).body;
const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
async function hook(carrierId: string, secret: string, payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  const res = await ctx.app.inject({ method: 'POST', url: `/webhooks/carriers/${carrierId}`, headers: { 'content-type': 'application/json', 'x-mudatex-signature': signature ?? sign(secret, body) }, payload: body });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

describe('delivery companies and parcel tracking', () => {
  it('lets staff hand a parcel to a delivery company by hand and follow it; the customer sees the same', async () => {
    const w = await world();
    const made = await call(ctx.app, 'POST', '/v1/carriers', w.s.a, { key: 'gig', name: 'GIG Logistics', kind: 'manual', trackingUrl: 'https://gig.example/track?no={ref}' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ key: 'gig', kind: 'manual', hasWebhookSecret: false });
    const o = await paidOrder(w);
    const sent = await call(ctx.app, 'POST', `/v1/sales-orders/${o.id}/steps`, w.s.a, { action: 'ship', carrierId: made.body.id, trackingRef: 'GIG 42/7' });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: 'shipped', carrier: 'GIG Logistics', trackingRef: 'GIG 42/7', shipment: { status: 'booked', carrierName: 'GIG Logistics', trackingUrl: 'https://gig.example/track?no=GIG%2042%2F7', events: [] } });

    expect((await call(ctx.app, 'POST', `/v1/sales-orders/${o.id}/shipment/events`, w.s.a, { status: 'out_for_delivery', description: 'With the rider', location: 'Kano' })).status).toBe(201);
    const mid = await detail(w, o.id);
    expect(mid.shipment).toMatchObject({ status: 'out_for_delivery', events: [expect.objectContaining({ status: 'out_for_delivery', description: 'With the rider', location: 'Kano' })] });
    expect(mid.status).toBe('shipped');

    const mine = await call(ctx.app, 'GET', `/shop/${w.s.slug}/me/orders/${o.orderNo}`, w.c.auth);
    expect(mine.body.shipment).toMatchObject({ status: 'out_for_delivery', trackingUrl: expect.stringContaining('gig.example') });
    expect(mine.body.shipment).not.toHaveProperty('source');

    await call(ctx.app, 'POST', `/v1/sales-orders/${o.id}/shipment/events`, w.s.a, { status: 'delivered', description: 'Signed by Amina' });
    const done = await detail(w, o.id);
    expect(done.status).toBe('delivered');
    expect(done.events.at(-1)).toMatchObject({ status: 'delivered', note: expect.stringContaining('GIG Logistics') });
  });

  it('keeps a free-text courier working, and a tracking number can belong to one order only', async () => {
    const w = await world();
    const o = await paidOrder(w);
    const sent = await call(ctx.app, 'POST', `/v1/sales-orders/${o.id}/steps`, w.s.a, { action: 'ship', carrier: 'Local rider', trackingRef: 'R1' });
    expect(sent.body.shipment).toMatchObject({ carrierName: 'Local rider', trackingUrl: null, status: 'booked' });

    const c = await call(ctx.app, 'POST', '/v1/carriers', w.s.a, { key: 'dup', name: 'Dup Express', kind: 'manual' });
    const a = await paidOrder(w); const b = await paidOrder(w);
    expect((await call(ctx.app, 'POST', `/v1/sales-orders/${a.id}/steps`, w.s.a, { action: 'ship', carrierId: c.body.id, trackingRef: 'SAME' })).status).toBe(200);
    const clash = await call(ctx.app, 'POST', `/v1/sales-orders/${b.id}/steps`, w.s.a, { action: 'ship', carrierId: c.body.id, trackingRef: 'SAME' });
    expect(clash.status).toBe(409);
    expect((await detail(w, b.id)).status).toBe('paid');   // nothing half-done
  });

  it('takes signed updates from a delivery company, translates its words, ignores repeats and late news, and closes the order on delivery', async () => {
    const w = await world();
    const made = await call(ctx.app, 'POST', '/v1/carriers', w.s.a, {
      key: 'hooky', name: 'Hooky Express', kind: 'webhook', trackingUrl: 'https://hooky.example/t/{ref}',
      statusMap: { 'shipment picked': 'picked_up', 'on the road': 'in_transit', 'arrived at customer': 'delivered', 'customer unreachable': 'failed' },
    });
    expect(made.status).toBe(201);
    expect(made.body.secret).toMatch(/^cws_/);
    expect((await call(ctx.app, 'GET', '/v1/carriers', w.s.a)).body.find((c: any) => c.key === 'hooky')).not.toHaveProperty('secret');
    const { id, secret } = made.body;
    const o = await paidOrder(w);
    await call(ctx.app, 'POST', `/v1/sales-orders/${o.id}/steps`, w.s.a, { action: 'ship', carrierId: id, trackingRef: 'HK-1' });

    expect((await hook(id, secret, { trackingRef: 'HK-1', status: 'Shipment picked' }, 'sha256=00')).status).toBe(401);
    expect((await hook(id, secret, { trackingRef: 'HK-1', status: 'Shipment picked' }, sign('cws_wrong', JSON.stringify({ trackingRef: 'HK-1', status: 'Shipment picked' })))).status).toBe(401);
    expect((await hook(id, secret, { nonsense: true })).status).toBe(400);

    const t0 = '2030-01-01T09:00:00.000Z'; const t1 = '2030-01-01T12:00:00.000Z'; const t2 = '2030-01-02T08:00:00.000Z';
    const first = await hook(id, secret, { events: [
      { trackingRef: 'HK-1', status: 'Shipment picked', occurredAt: t0, eventId: 'e1', location: 'Kano hub' },
      { trackingRef: 'HK-1', status: 'On the road', occurredAt: t1, eventId: 'e2' },
      { trackingRef: 'HK-NOPE', status: 'On the road' },
    ] });
    expect(first).toMatchObject({ status: 200, body: { recorded: 2, duplicate: 0, unknown: 1 } });
    expect((await detail(w, o.id)).shipment).toMatchObject({ status: 'in_transit', events: [expect.objectContaining({ status: 'in_transit' }), expect.objectContaining({ status: 'picked_up', location: 'Kano hub' })] });

    // the same message again, and an older one arriving late, change nothing
    expect((await hook(id, secret, { trackingRef: 'HK-1', status: 'On the road', occurredAt: t1, eventId: 'e2' })).body).toMatchObject({ recorded: 0, duplicate: 1 });
    await hook(id, secret, { trackingRef: 'HK-1', status: 'Shipment picked', occurredAt: '2029-12-31T00:00:00.000Z', eventId: 'e0' });
    expect((await detail(w, o.id)).shipment.status).toBe('in_transit');

    // a word we were not told about is kept as a note and does not move the parcel
    await hook(id, secret, { trackingRef: 'HK-1', status: 'Sorting at depot', occurredAt: '2030-01-01T13:00:00.000Z', eventId: 'e3' });
    const noted = (await detail(w, o.id)).shipment;
    expect(noted.status).toBe('in_transit');
    expect(noted.events[0]).toMatchObject({ status: null, description: '(Sorting at depot)' });

    // a failed attempt leaves a note for staff
    await hook(id, secret, { trackingRef: 'HK-1', status: 'Customer unreachable', description: 'Phone off', occurredAt: '2030-01-01T16:00:00.000Z', eventId: 'e4' });
    const failed = await detail(w, o.id);
    expect(failed.shipment.status).toBe('failed');
    expect(failed.status).toBe('shipped');
    expect(failed.events.at(-1).note).toContain('Delivery failed (Hooky Express): Phone off');

    await hook(id, secret, { trackingRef: 'HK-1', status: 'Arrived at customer', occurredAt: t2, eventId: 'e5' });
    const arrived = await detail(w, o.id);
    expect(arrived.shipment.status).toBe('delivered');
    expect(arrived.status).toBe('delivered');

    // a switched-off company is acknowledged and ignored
    await call(ctx.app, 'PUT', `/v1/carriers/${id}`, w.s.a, { active: false });
    expect((await hook(id, secret, { trackingRef: 'HK-1', status: 'On the road', eventId: 'e9' })).body).toMatchObject({ ignored: 'inactive' });
    expect((await hook(crypto.randomUUID(), secret, { trackingRef: 'HK-1', status: 'x' })).status).toBe(404);
  });

  it('rotates the signing secret: the old one stops working at once', async () => {
    const w = await world();
    const made = await call(ctx.app, 'POST', '/v1/carriers', w.s.a, { key: 'rot', name: 'Rotating Co', kind: 'webhook' });
    const rotated = await call(ctx.app, 'POST', `/v1/carriers/${made.body.id}/rotate-secret`, w.s.a);
    expect(rotated.body.secret).not.toBe(made.body.secret);
    const payload = { trackingRef: 'X', status: 'in_transit' };
    expect((await hook(made.body.id, made.body.secret, payload)).status).toBe(401);
    expect((await hook(made.body.id, rotated.body.secret, payload)).status).toBe(200);
  });

  it('books with a delivery company that has a connector, refuses cleanly when it is down, and then follows the parcel by asking', async () => {
    const w = await world();
    expect((await call(ctx.app, 'POST', '/v1/carriers', w.s.a, { key: 'ghost', name: 'Ghost Co', kind: 'api', adapter: 'nonexistent' })).status).toBe(422);
    const made = await call(ctx.app, 'POST', '/v1/carriers', w.s.a, { key: 'fx', name: 'Fake Express', kind: 'api', adapter: 'fakeexpress', credentials: { apiKey: 'k-123' } });
    expect(made.status).toBe(201);
    expect(JSON.stringify(made.body)).not.toContain('k-123');
    expect(made.body.hasCredentials).toBe(true);
    expect((await call(ctx.app, 'GET', '/v1/carrier-adapters', w.s.a)).body).toEqual([{ key: 'fakeexpress', books: true, tracks: true }]);

    const o = await paidOrder(w);
    down = true;
    const refused = await call(ctx.app, 'POST', `/v1/sales-orders/${o.id}/steps`, w.s.a, { action: 'ship', carrierId: made.body.id });
    expect(refused.status).toBe(502);
    expect(refused.body.message).toContain('Fake Express could not book the parcel');
    expect((await detail(w, o.id)).status).toBe('paid');
    down = false;

    const sent = await call(ctx.app, 'POST', `/v1/sales-orders/${o.id}/steps`, w.s.a, { action: 'ship', carrierId: made.body.id });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ trackingRef: `FX-${o.orderNo}`, shipment: { carrierName: 'Fake Express', eta: '2030-01-05' } });

    const box = createSecretBox(KEY);
    tracked.set(`FX-${o.orderNo}`, [{ status: 'in_transit', occurredAt: '2030-01-02T10:00:00.000Z' }]);
    expect(await pollShipments(ctx.db, box, { fakeexpress: fake })).toMatchObject({ failed: 0 });
    expect((await detail(w, o.id)).shipment).toMatchObject({ status: 'in_transit', eta: '2030-01-06' });

    // asked once, not again straight away
    const again = await pollShipments(ctx.db, box, { fakeexpress: fake });
    expect(again.asked).toBe(0);

    tracked.set(`FX-${o.orderNo}`, [{ status: 'in_transit', occurredAt: '2030-01-02T10:00:00.000Z' }, { status: 'delivered', occurredAt: '2030-01-03T10:00:00.000Z' }]);
    await ctx.db.query(`UPDATE shipments SET polled_at = now() - interval '2 hours' WHERE order_id = $1`, [o.id]);
    await pollShipments(ctx.db, box, { fakeexpress: fake });
    expect(await detail(w, o.id)).toMatchObject({ status: 'delivered', shipment: { status: 'delivered' } });
    expect(booked).toBeGreaterThan(0);
  });

  it('is for people who may manage delivery companies, and fulfilment staff may only choose among them', async () => {
    const w = await world();
    const clerk = await staff(ctx.app, w.s.a, ['orders.fulfil', 'orders.read'], { type: 'legal_entity', id: w.s.w.ng });
    expect((await call(ctx.app, 'POST', '/v1/carriers', clerk.auth, { key: 'nope', name: 'Nope Co', kind: 'manual' })).status).toBe(403);
    expect((await call(ctx.app, 'GET', '/v1/carriers', clerk.auth)).status).toBe(200);
    const nobody = await staff(ctx.app, w.s.a, ['orders.read'], { type: 'legal_entity', id: w.s.w.ng });
    expect((await call(ctx.app, 'GET', '/v1/carriers', nobody.auth)).status).toBe(403);
    expect((await call(ctx.app, 'POST', '/v1/carriers', w.s.a, { key: 'bad key', name: 'Bad', kind: 'manual' })).status).toBe(400);
    expect((await call(ctx.app, 'POST', '/v1/carriers', w.s.a, { key: 'plain', name: 'Plain', kind: 'manual', trackingUrl: 'http://insecure.example/{ref}' })).status).toBe(400);
    expect((await call(ctx.app, 'POST', '/v1/carriers', w.s.a, { key: 'plain', name: 'Plain', kind: 'manual' })).status).toBe(201);
    expect((await call(ctx.app, 'POST', '/v1/carriers', w.s.a, { key: 'plain', name: 'Plain again', kind: 'manual' })).status).toBe(409);
  });
});
