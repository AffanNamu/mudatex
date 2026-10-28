import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/events/dispatcher.js';
import { createTermii, orderSmsConsumer, renderOrderSms, smsNumber, type Texter } from '../src/notify/sms.js';
import { call, setupApp } from './helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

describe('smsNumber', () => {
  it('turns what people type into digits with the country code, or nothing', () => {
    expect(smsNumber('+234 801 234 5678')).toBe('2348012345678');
    expect(smsNumber('0801 234 5678')).toBe('2348012345678');
    expect(smsNumber('00233 24 123 4567')).toBe('233241234567');
    expect(smsNumber('12345')).toBeNull();
    expect(smsNumber('call me')).toBeNull();
    expect(smsNumber(null)).toBeNull();
  });
});

describe('Termii', () => {
  it('posts the message with the key and sender, and reports acceptance', async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const ok = createTermii({ apiKey: 'k-123456789', senderId: 'Mudatex', fetch: (async (url: string, init: RequestInit) => { seen.push({ url, body: JSON.parse(String(init.body)) }); return new Response('{}', { status: 200 }); }) as typeof fetch });
    expect(await ok.send('2348012345678', 'Hello')).toBe('ok');
    expect(seen[0]).toEqual({ url: 'https://api.ng.termii.com/api/sms/send', body: { to: '2348012345678', from: 'Mudatex', sms: 'Hello', type: 'plain', channel: 'generic', api_key: 'k-123456789' } });
    const down = createTermii({ apiKey: 'k-123456789', senderId: 'Mudatex', fetch: (async () => new Response('no', { status: 500 })) as typeof fetch });
    expect(await down.send('2348012345678', 'Hello')).toBe('failed');
    const broken = createTermii({ apiKey: 'k-123456789', senderId: 'Mudatex', fetch: (async () => { throw new Error('offline'); }) as typeof fetch });
    expect(await broken.send('2348012345678', 'Hello')).toBe('failed');
  });
});

describe('order texts', () => {
  it('are short, in the shopper\'s language, and say where to look', () => {
    expect(renderOrderSms('order.ship', { orderNo: 'SO-000007' }, { name: 'Mudatex', siteUrl: 'https://shop.example.test' }, 'en')).toBe('Mudatex: Your order SO-000007 is on its way. https://shop.example.test/orders/SO-000007');
    expect(renderOrderSms('order.deliver', { orderNo: 'SO-000007' }, { name: 'Mudatex', siteUrl: null }, 'fr')).toBe('Mudatex: Votre commande SO-000007 a été livrée.');
    expect(renderOrderSms('order.place', { orderNo: 'SO-000007' }, { name: 'Mudatex', siteUrl: null }, 'en')).toBeNull();   // only the moments worth a text; place is not one of them
  });
});

async function setup() {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { siteUrl: 'https://shop.example.test', contact: { bankName: 'Test Bank', accountName: 'Textiles Ltd', accountNumber: '0123456789' } });
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  const c = await shopper(`sms-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Amina Yusuf', phone: '+2348011111111' });
  const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Amina Yusuf', phone: '0801 111 1111', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
  return { s, c, addr: addr.body.id as string };
}

describe('text messages about orders', () => {
  it('go only to shoppers who asked, once per event, and are retried when the provider refuses', async () => {
    const w = await setup();
    const sent: { to: string; text: string }[] = [];
    let refuse = 0;
    const texter: Texter = { async send(to, text) { if (refuse > 0) { refuse--; return 'failed'; } sent.push({ to, text }); return 'ok'; } };
    const d = new Dispatcher(ctx.db, { secretBox: null, urlPolicy: { allowHttp: false, allowPrivate: false }, consumers: [orderSmsConsumer(texter)] });
    const drain = async () => { for (let i = 0; i < 2000; i++) if ((await d.runOnce(new Date(Date.now() + 3_600_000))) === 0) return; };
    const place = async () => {
      const o = await call(ctx.app, 'POST', `/shop/${w.s.slug}/me/orders`, { ...w.c.auth, 'idempotency-key': crypto.randomUUID() }, { lines: [{ variantId: w.s.w.fabric.variantId, quantity: '1' }], addressId: w.addr, paymentMethod: 'bank_transfer' });
      expect(o.status).toBe(201);
      return o.body as { id: string; orderNo: string; totalMinor: number };
    };
    const pay = (o: { id: string; totalMinor: number }) => call(ctx.app, 'POST', `/v1/sales-orders/${o.id}/payments`, w.s.a, { method: 'bank_transfer', reference: `SM-${uniq()}`, amountMinor: o.totalMinor });

    // not asked for: nothing is sent
    const first = await place(); await pay(first);
    await drain();
    expect(sent).toEqual([]);

    // asked for in the account
    const profile = await call(ctx.app, 'PUT', `/shop/${w.s.slug}/me`, w.c.auth, { fullName: 'Amina Yusuf', smsOptIn: true });
    expect(profile.body.smsOptIn).toBe(true);
    const second = await place();
    await drain();
    expect(sent).toEqual([]);   // placing an order is not a text
    refuse = 1;
    await pay(second);
    await d.runOnce();   // fan out
    await d.runOnce();   // refused once...
    expect(sent).toEqual([]);
    await drain();       // ...and tried again later
    expect(sent).toEqual([{ to: '2348011111111', text: `Test Shop: Payment received for ${second.orderNo}. https://shop.example.test/orders/${second.orderNo}` }]);
    await call(ctx.app, 'POST', `/v1/sales-orders/${second.id}/steps`, w.s.a, { action: 'ship' });
    await drain(); await drain();
    expect(sent.map((m) => m.text)).toEqual([expect.stringContaining('Payment received'), expect.stringContaining('is on its way')]);

    // switched off again
    await call(ctx.app, 'PUT', `/shop/${w.s.slug}/me`, w.c.auth, { fullName: 'Amina Yusuf', smsOptIn: false });
    await call(ctx.app, 'POST', `/v1/sales-orders/${second.id}/steps`, w.s.a, { action: 'deliver' });
    await drain();
    expect(sent).toHaveLength(2);
  });
});
