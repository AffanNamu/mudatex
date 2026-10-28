import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasMessage, languageOf, SHOP_MESSAGES, shopMessage, type ShopMessageKey } from '../src/shop/messages.js';
import { call, setupApp, staff } from './helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('shop message catalogues', () => {
  const keys = Object.keys(SHOP_MESSAGES.en) as ShopMessageKey[];
  for (const lang of ['fr', 'ha'] as const) {
    it(`${lang} has every message with the same placeholders`, () => {
      expect(Object.keys(SHOP_MESSAGES[lang]).sort()).toEqual([...keys].sort());
      expect(keys.filter((k) => JSON.stringify(placeholders(SHOP_MESSAGES[lang][k])) !== JSON.stringify(placeholders(SHOP_MESSAGES.en[k])))).toEqual([]);
      expect(keys.filter((k) => !SHOP_MESSAGES[lang][k].trim())).toEqual([]);
    });
  }
  it('reads the first supported language from Accept-Language', () => {
    expect(languageOf('fr-NG,fr;q=0.9,en;q=0.5')).toBe('fr');
    expect(languageOf('de, ha;q=0.8')).toBe('ha');
    expect(languageOf('de')).toBe('en');
    expect(languageOf(undefined)).toBe('en');
    expect(hasMessage('err.coupon.expired')).toBe(true);
    expect(hasMessage('err.nonsense')).toBe(false);
  });
  it('words a status inside a sentence in the same language', () => {
    expect(shopMessage('fr', 'err.order.cancel', { status: '@err.status.shipped' })).toBe('Une commande en route ne peut plus être annulée');
    expect(shopMessage('en', 'err.order.cancel', { status: '@err.status.shipped' })).toBe('An order that is on its way can no longer be cancelled');
  });
});

describe('answers in the shopper\'s language', () => {
  async function liveShop() {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { siteUrl: 'https://shop.example.test' });
    await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
    return s;
  }
  const withLang = (auth: Record<string, string> | undefined, lang: string) => ({ ...(auth ?? {}), 'accept-language': lang }) as { authorization: string } & Record<string, string>;

  it('words coupon, delivery, not-found and sign-in refusals in French or Hausa, and leaves English alone', async () => {
    const s = await liveShop();
    const basket = (lang: string, couponCode: string) => call(ctx.app, 'POST', `/shop/${s.slug}/basket`, withLang(undefined, lang), { lines: [{ variantId: s.w.fabric.variantId, quantity: '1' }], couponCode });
    const en = await basket('en', 'NOSUCH');
    expect(en).toMatchObject({ status: 422, body: { message: 'That coupon code is not valid' } });
    expect((await basket('fr-NG,fr;q=0.9', 'NOSUCH')).body.message).toBe('Ce code promo n’est pas valable');
    expect((await basket('ha', 'NOSUCH')).body.message).toBe('Wannan lambar kuponi ba ta da inganci');
    expect((await basket('de', 'NOSUCH')).body.message).toBe('That coupon code is not valid');

    const quote = await call(ctx.app, 'POST', `/shop/${s.slug}/delivery-quote`, withLang(undefined, 'fr'), { countryCode: 'GH', state: 'Accra', subtotalMinor: 100 });
    expect(quote.body.message).toBe('Nous ne livrons pas encore à cet endroit');
    expect((await call(ctx.app, 'GET', `/shop/${s.slug}/products/nothing-here`, withLang(undefined, 'ha'))).body.message).toBe('Ba a sami kaya ba');
    expect((await call(ctx.app, 'GET', `/shop/${s.slug}/me`, withLang(undefined, 'fr'))).body.message).toBe('Authentification requise');
  });

  it('words order refusals including the order status, and validation text, for the signed-in shopper', async () => {
    const s = await liveShop();
    const c = await shopper(`msg-${uniq()}@example.test`);
    await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Amina Yusuf' });
    const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Amina Yusuf', phone: '+2348011111111', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
    const order = await call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...c.auth, 'idempotency-key': crypto.randomUUID() }, { lines: [{ variantId: s.w.fabric.variantId, quantity: '1' }], addressId: addr.body.id, paymentMethod: 'bank_transfer' });
    const orderNo = order.body.orderNo as string;
    await call(ctx.app, 'POST', `/v1/sales-orders/${order.body.id}/payments`, s.a, { method: 'bank_transfer', reference: `M-${uniq()}`, amountMinor: order.body.totalMinor });
    await call(ctx.app, 'POST', `/v1/sales-orders/${order.body.id}/steps`, s.a, { action: 'process' });
    await call(ctx.app, 'POST', `/v1/sales-orders/${order.body.id}/steps`, s.a, { action: 'ship', carrier: 'GIG', trackingRef: 'G1' });
    const cancel = (lang: string) => call(ctx.app, 'POST', `/shop/${s.slug}/me/orders/${orderNo}/cancel`, { ...withLang(c.auth, lang), 'idempotency-key': crypto.randomUUID() });
    expect((await cancel('en')).body.message).toBe('An order that is shipped can no longer be cancelled here; contact the store');
    expect((await cancel('fr')).body.message).toBe('Une commande en route ne peut plus être annulée ici ; contactez la boutique');
    expect((await cancel('ha')).body.message).toContain('yana kan hanya');

    const enquiry = (lang: string) => call(ctx.app, 'POST', `/shop/${s.slug}/enquiries`, withLang(undefined, lang), { kind: 'contact', name: 'Ngozi Eze', message: 'I need help with my order please.' });
    const fr = await enquiry('fr');
    expect(fr.status).toBe(400);
    expect(fr.body.issues[0].message).toBe('Indiquez une adresse e-mail ou un numéro de téléphone pour que nous puissions vous répondre');
    expect((await enquiry('en')).body.issues[0].message).toBe('Give an email address or a phone number so we can reply');
  });

  it('never changes what staff see, even when a staff request carries a language', async () => {
    const s = await liveShop();
    const clerk = await staff(ctx.app, s.a, ['catalog.read'], { type: 'legal_entity', id: s.w.ng });
    const r = await call(ctx.app, 'GET', `/v1/storefronts/${s.id}/translations`, withLang(clerk.auth, 'fr'));
    expect(r.status).toBe(403);
    expect(r.body.message).toBe('Not permitted for this scope');
  });
});
