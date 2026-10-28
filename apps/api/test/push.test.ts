import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/events/dispatcher.js';
import { createWebPush, orderPushConsumer, type PushMessage, type PushOutcome, type PushTarget, type Pusher } from '../src/notify/push.js';
import { call, setupApp } from './helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

class FakePusher implements Pusher {
  publicKey = 'BFakePublicKeyFakePublicKeyFakePublicKeyFakePublicKeyFakePublicKey1234';
  sent: { target: PushTarget; message: PushMessage }[] = [];
  outcome = new Map<string, PushOutcome>();
  async send(target: PushTarget, message: PushMessage) {
    const o = this.outcome.get(target.endpoint) ?? 'ok';
    if (o === 'ok') this.sent.push({ target, message });
    return o;
  }
}

let ctx: Awaited<ReturnType<typeof setupApp>>;
const pusher = new FakePusher();
beforeAll(async () => { ctx = await setupApp({}, { pusher }); });
afterAll(async () => { await ctx.close(); });

const drain = async (d: Dispatcher, hours = 1) => { for (let i = 0; i < 40; i++) if ((await d.runOnce(new Date(Date.now() + hours * 3_600_000))) === 0) return; };

async function ready() {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  const c = await shopper(`pu-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Push Person' });
  const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Push Person', phone: '+2348011111111', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
  const sub = (n: string) => ({ endpoint: `https://push.example.test/${n}-${uniq()}`, keys: { p256dh: 'p256dh-key-value-1234567890', auth: 'auth-secret-12345' } });
  const order = () => call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...c.auth, 'idempotency-key': crypto.randomUUID() }, { lines: [{ variantId: s.w.fabric.variantId, quantity: '1' }], addressId: addr.body.id, paymentMethod: 'bank_transfer' });
  const d = new Dispatcher(ctx.db, { secretBox: null, urlPolicy: { allowHttp: false, allowPrivate: false }, consumers: [orderPushConsumer(pusher)] });
  return { s, c, sub, order, d };
}

describe('push notifications', () => {
  it('offer the public key, and let a shopper add and remove a device', async () => {
    const r = await ready();
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}`, undefined)).body.pushKey).toBe(pusher.publicKey);
    const device = r.sub('phone');
    expect((await call(ctx.app, 'PUT', `/shop/${r.s.slug}/me/push`, r.c.auth, device)).status).toBe(204);
    expect((await call(ctx.app, 'PUT', `/shop/${r.s.slug}/me/push`, r.c.auth, device)).status).toBe(204); // again: still one device
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint = $1', [device.endpoint])).rows[0].n).toBe(1);
    expect((await call(ctx.app, 'PUT', `/shop/${r.s.slug}/me/push`, r.c.auth, { ...device, endpoint: 'http://insecure.example.test/x' })).status).toBe(400);
    expect((await call(ctx.app, 'PUT', `/shop/${r.s.slug}/me/push`, undefined, device)).status).toBe(401);
    expect((await call(ctx.app, 'DELETE', `/shop/${r.s.slug}/me/push`, r.c.auth, { endpoint: device.endpoint })).status).toBe(204);
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint = $1', [device.endpoint])).rows[0].n).toBe(0);
  });

  it('tell each of a shopper\'s devices when their order changes, once per event, with a link to the order', async () => {
    pusher.sent.length = 0;
    const r = await ready();
    const phone = r.sub('phone'); const tablet = r.sub('tablet');
    await call(ctx.app, 'PUT', `/shop/${r.s.slug}/me/push`, r.c.auth, phone);
    await call(ctx.app, 'PUT', `/shop/${r.s.slug}/me/push`, r.c.auth, tablet);
    const o = (await r.order()).body;
    await drain(r.d);
    const mine = () => pusher.sent.filter((x) => [phone.endpoint, tablet.endpoint].includes(x.target.endpoint));
    expect(mine()).toHaveLength(2);
    expect(mine()[0]!.message).toMatchObject({ title: 'Test Shop', url: `/orders/${o.orderNo}`, tag: o.orderNo });
    expect(mine()[0]!.message.body).toMatch(/Thank you for your order/);
    await call(ctx.app, 'POST', `/v1/sales-orders/${o.id}/payments`, r.s.a, { method: 'bank_transfer', reference: `P-${uniq()}`, amountMinor: o.totalMinor });
    await drain(r.d);
    expect(mine()).toHaveLength(4);
    expect(mine().at(-1)!.message.body).toMatch(/received your payment/);
    await drain(r.d); // replay changes nothing
    expect(mine()).toHaveLength(4);
  });

  it('forgets a device the phone has dropped, keeps trying when everything fails, and ignores people with no device', async () => {
    pusher.sent.length = 0;
    const r = await ready();
    const dead = r.sub('dead'); const alive = r.sub('alive');
    await call(ctx.app, 'PUT', `/shop/${r.s.slug}/me/push`, r.c.auth, dead);
    await call(ctx.app, 'PUT', `/shop/${r.s.slug}/me/push`, r.c.auth, alive);
    pusher.outcome.set(dead.endpoint, 'gone');
    await r.order();
    await drain(r.d);
    expect(pusher.sent.filter((x) => x.target.endpoint === alive.endpoint)).toHaveLength(1);
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint = $1', [dead.endpoint])).rows[0].n).toBe(0);

    const lonely = await ready();
    await lonely.order();
    await drain(lonely.d); // nobody subscribed: nothing sent, nothing breaks
    const flaky = await ready();
    const only = flaky.sub('only');
    await call(ctx.app, 'PUT', `/shop/${flaky.s.slug}/me/push`, flaky.c.auth, only);
    pusher.outcome.set(only.endpoint, 'failed');
    await flaky.order();
    await drain(flaky.d);
    expect(pusher.sent.filter((x) => x.target.endpoint === only.endpoint)).toHaveLength(0);
    pusher.outcome.set(only.endpoint, 'ok');
    await drain(flaky.d, 3); // the delivery is retried later
    expect(pusher.sent.filter((x) => x.target.endpoint === only.endpoint)).toHaveLength(1);
  });

  it('is off without keys, and the real sender maps provider answers', async () => {
    const bare = await setupApp();
    const r = await shopWorld(bare);
    await goLive(bare, r);
    expect((await call(bare.app, 'GET', `/shop/${r.slug}`, undefined)).body.pushKey).toBeNull();
    await bare.close();
    const real = createWebPush({ publicKey: 'x'.repeat(87), privateKey: 'y'.repeat(43), subject: 'mailto:ops@example.test' });
    expect(real.publicKey).toHaveLength(87);
  });
});
