import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/events/dispatcher.js';
import { createResend, type Mail, type Mailer } from '../src/notify/mailer.js';
import { orderEmailConsumer, renderOrderEmail } from '../src/notify/order-emails.js';
import { call, setupApp } from './helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

class Outbox implements Mailer {
  sent: Mail[] = [];
  failNext = 0;
  async send(m: Mail) {
    if (this.failNext > 0) { this.failNext--; throw new Error('mail down'); }
    this.sent.push(m);
  }
}

async function drain(d: Dispatcher) {
  for (let i = 0; i < 2000; i++) if ((await d.runOnce(new Date(Date.now() + 3_600_000))) === 0) return;
}

async function ready(mailer: Mailer) {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { siteUrl: 'https://shop.example.test', contact: { bankName: 'Test Bank', accountName: 'Textiles Ltd', accountNumber: '0123456789' } });
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  const c = await shopper(`mail-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Amina <b>Yusuf</b>' });
  const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Amina Yusuf', phone: '+2348011111111', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
  const order = await call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...c.auth, 'idempotency-key': crypto.randomUUID() }, {
    lines: [{ variantId: s.w.fabric.variantId, quantity: '2' }], addressId: addr.body.id, paymentMethod: 'bank_transfer',
  });
  const d = new Dispatcher(ctx.db, { secretBox: null, urlPolicy: { allowHttp: false, allowPrivate: false }, consumers: [orderEmailConsumer(mailer)] });
  return { s, c, order: order.body, d };
}

describe('order emails', () => {
  it('tell the customer at each step, with bank details and a link, and escape their name', async () => {
    const mailer = new Outbox();
    const r = await ready(mailer);
    await drain(r.d);
    const mine = () => mailer.sent.filter((m) => m.to === r.c.email);
    expect(mine()).toHaveLength(1);
    const placed = mine()[0]!;
    expect(placed).toMatchObject({ to: r.c.email, subject: `We have your order ${r.order.orderNo}` });
    expect(placed.text).toContain('0123456789');
    expect(placed.text).toContain(`https://shop.example.test/orders/${r.order.orderNo}`);
    expect(placed.text).toContain('₦8,526.08'); // 2 m + VAT + 1,000 delivery
    expect(placed.html).not.toContain('<b>Yusuf</b>');
    expect(placed.html).toContain('&lt;b&gt;Yusuf&lt;/b&gt;');

    await call(ctx.app, 'POST', `/v1/sales-orders/${r.order.id}/payments`, r.s.a, { method: 'bank_transfer', reference: `M-${uniq()}`, amountMinor: r.order.totalMinor });
    await call(ctx.app, 'POST', `/v1/sales-orders/${r.order.id}/steps`, r.s.a, { action: 'process' });
    await call(ctx.app, 'POST', `/v1/sales-orders/${r.order.id}/steps`, r.s.a, { action: 'ship', carrier: 'GIG', trackingRef: 'GIG9' });
    await call(ctx.app, 'POST', `/v1/sales-orders/${r.order.id}/steps`, r.s.a, { action: 'deliver' });
    await drain(r.d);
    expect(mine().map((m) => m.subject)).toEqual([
      `We have your order ${r.order.orderNo}`, `Payment received for ${r.order.orderNo}`, `Your order ${r.order.orderNo} is on its way`, `Your order ${r.order.orderNo} was delivered`,
    ]);
    expect(mine()[2]!.text).toContain('GIG9');
  });

  it('sends once per event even when the delivery is replayed, and retries a failed send', async () => {
    const mailer = new Outbox();
    const r = await ready(mailer);
    mailer.failNext = 1;
    await r.d.runOnce(); // fan out
    await r.d.runOnce(); // first attempt fails
    expect(mailer.sent.filter((m) => m.to === r.c.email)).toHaveLength(0);
    await drain(r.d);
    expect(mailer.sent.filter((m) => m.to === r.c.email)).toHaveLength(1);
    const { rows } = await ctx.db.query(`SELECT count(*)::int AS n FROM notification_log WHERE recipient = $1`, [r.c.email]);
    expect(rows[0].n).toBe(1);
  });

  it('says what happened when an order is cancelled with money paid', () => {
    const order = { orderNo: 'SO-000009', currency: 'NGN', minorUnit: 2, totalMinor: 100000, deliveryFeeMinor: 0, refundDueMinor: 100000, paymentMethod: 'card', contact: { name: 'Ada', email: 'ada@example.test' }, lines: [], expiresAt: new Date().toISOString() };
    const mail = renderOrderEmail('order.cancel', order, { name: 'Shop', siteUrl: null, contact: {} })!;
    expect(mail.text).toContain('We owe you a refund');
    expect(mail.text).not.toContain('View your order');
    expect(renderOrderEmail('order.process', order, { name: 'Shop', siteUrl: null, contact: {} })).toBeNull();
  });
});

describe('the Resend mailer', () => {
  it('posts the message with the key and fails loudly when refused', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const ok = createResend('re_testkey_123', 'Shop <orders@shop.test>', (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch);
    await ok.send({ to: 'a@b.test', subject: 'Hi', text: 't', html: '<p>t</p>' });
    expect(seen[0]!.url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(seen[0]!.init.body as string)).toMatchObject({ from: 'Shop <orders@shop.test>', to: ['a@b.test'], subject: 'Hi' });
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer re_testkey_123');
    const refused = createResend('k', 'f@x.test', (async () => new Response('no', { status: 422 })) as unknown as typeof fetch);
    await expect(refused.send({ to: 'a@b.test', subject: 'x', text: 'x', html: 'x' })).rejects.toMatchObject({ status: 502 });
  });
});
