import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/events/dispatcher.js';
import type { Mail, Mailer } from '../src/notify/mailer.js';
import { orderEmailConsumer } from '../src/notify/order-emails.js';
import { call, setupApp, staff } from './helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

const put = (s: Awaited<ReturnType<typeof shopWorld>>, body: unknown, auth = s.a) => call(ctx.app, 'PUT', `/v1/storefronts/${s.id}/translations`, auth, body);

async function liveShop() {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { tagline: 'Quality textiles' });
  return { s };
}
const storefrontProductId = async (slug: string) => (await call(ctx.app, 'GET', `/shop/${slug}/products/ankara-wax`, undefined)).body.id as string;

describe('translated shop content', () => {
  it('overlays French and Hausa on the public payloads and leaves English as the fallback', async () => {
    const { s } = await liveShop();
    const spId = await storefrontProductId(s.slug);
    const r = await put(s, {
      lang: 'fr',
      entries: [
        { entityType: 'store', entityId: s.id, field: 'tagline', value: 'Des textiles de qualité' },
        { entityType: 'department', entityId: s.deptId, field: 'name', value: 'Tissus' },
        { entityType: 'product', entityId: spId, field: 'title', value: 'Wax Ankara' },
        { entityType: 'product', entityId: spId, field: 'description', value: 'Un beau tissu.' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ saved: 4, removed: 0 });
    await put(s, { lang: 'ha', entries: [{ entityType: 'product', entityId: spId, field: 'title', value: 'Ankara Wax (Hausa)' }] });

    const store = (await call(ctx.app, 'GET', `/shop/${s.slug}`, undefined)).body;
    expect(store.tagline).toBe('Quality textiles');
    expect(store.i18n).toEqual({ fr: { tagline: 'Des textiles de qualité' } });
    expect(store.departments[0]).toMatchObject({ name: 'Fabrics', i18n: { fr: { name: 'Tissus' } } });
    expect(store.featured[0]).toMatchObject({ title: 'Ankara Wax', i18n: { fr: { title: 'Wax Ankara', description: 'Un beau tissu.' }, ha: { title: 'Ankara Wax (Hausa)' } } });
    expect(store.featured[0].department.i18n).toEqual({ fr: { name: 'Tissus' } });

    const list = (await call(ctx.app, 'GET', `/shop/${s.slug}/products`, undefined)).body;
    expect(list.items[0].i18n.fr.title).toBe('Wax Ankara');
    const detail = (await call(ctx.app, 'GET', `/shop/${s.slug}/products/ankara-wax`, undefined)).body;
    expect(detail).toMatchObject({ title: 'Ankara Wax', i18n: { fr: { title: 'Wax Ankara', description: 'Un beau tissu.' } } });
    expect(detail.department.i18n.fr.name).toBe('Tissus');

    const rows = (await call(ctx.app, 'GET', `/v1/storefronts/${s.id}/translations`, s.a)).body;
    expect(rows).toHaveLength(5);

    // Clearing a field brings the English back.
    const cleared = await put(s, { lang: 'fr', entries: [{ entityType: 'product', entityId: spId, field: 'title', value: '  ' }] });
    expect(cleared.body).toEqual({ saved: 0, removed: 1 });
    const again = (await call(ctx.app, 'GET', `/shop/${s.slug}/products/ankara-wax`, undefined)).body;
    expect(again.i18n.fr).toEqual({ description: 'Un beau tissu.' });
  });

  it('sends nothing extra for untranslated shops', async () => {
    const { s } = await liveShop();
    const store = (await call(ctx.app, 'GET', `/shop/${s.slug}`, undefined)).body;
    expect(store.i18n).toBeUndefined();
    expect(store.featured[0].i18n).toBeUndefined();
  });

  it('refuses mistakes: wrong fields, strangers\' entities, repeats, long text, English, and people without rights', async () => {
    const { s } = await liveShop();
    const other = await liveShop();
    const spId = await storefrontProductId(s.slug);
    const otherSp = await storefrontProductId(other.s.slug);
    expect((await put(s, { lang: 'fr', entries: [{ entityType: 'department', entityId: s.deptId, field: 'title', value: 'x' }] })).status).toBe(422);
    expect((await put(s, { lang: 'fr', entries: [{ entityType: 'product', entityId: otherSp, field: 'title', value: 'x' }] })).status).toBe(404);
    expect((await put(s, { lang: 'fr', entries: [{ entityType: 'store', entityId: other.s.id, field: 'tagline', value: 'x' }] })).status).toBe(404);
    expect((await put(s, { lang: 'fr', entries: [{ entityType: 'product', entityId: spId, field: 'title', value: 'a' }, { entityType: 'product', entityId: spId, field: 'title', value: 'b' }] })).status).toBe(422);
    expect((await put(s, { lang: 'fr', entries: [{ entityType: 'product', entityId: spId, field: 'title', value: 'x'.repeat(161) }] })).status).toBe(422);
    expect((await put(s, { lang: 'en', entries: [{ entityType: 'product', entityId: spId, field: 'title', value: 'x' }] })).status).toBe(400);
    const clerk = await staff(ctx.app, s.a, ['catalog.read'], { type: 'legal_entity', id: s.w.ng });
    expect((await put(s, { lang: 'fr', entries: [{ entityType: 'product', entityId: spId, field: 'title', value: 'x' }] }, clerk.auth)).status).toBe(403);
    expect((await call(ctx.app, 'GET', `/v1/storefronts/${s.id}/translations`, clerk.auth)).status).toBe(403);
  });

  it('drops a department\'s translations when the department is deleted', async () => {
    const s = await shopWorld(ctx);
    await put(s, { lang: 'fr', entries: [{ entityType: 'department', entityId: s.deptId, field: 'name', value: 'Tissus' }] });
    expect((await call(ctx.app, 'DELETE', `/v1/storefronts/${s.id}/departments/${s.deptId}`, s.a)).status).toBe(204);
    expect((await call(ctx.app, 'GET', `/v1/storefronts/${s.id}/translations`, s.a)).body).toEqual([]);
  });
});

class Outbox implements Mailer {
  sent: Mail[] = [];
  async send(m: Mail) { this.sent.push(m); }
}

describe('a shopper\'s language', () => {
  it('is saved with the profile or on its own, and rejects unknown languages', async () => {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    const c = await shopper(`lang-${uniq()}@example.test`);
    const made = await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Amina Yusuf', language: 'ha' });
    expect(made.body.language).toBe('ha');
    expect((await call(ctx.app, 'PUT', `/shop/${s.slug}/me/language`, c.auth, { language: 'fr' })).body.language).toBe('fr');
    expect((await call(ctx.app, 'PUT', `/shop/${s.slug}/me/language`, c.auth, { language: 'de' })).status).toBe(400);
    expect((await call(ctx.app, 'PUT', `/shop/${s.slug}/me`, c.auth, { fullName: 'Amina Yusuf' })).body.language).toBe('fr'); // an update that says nothing keeps it
    const d = await shopper(`lang-${uniq()}@example.test`);
    expect((await call(ctx.app, 'POST', `/shop/${s.slug}/me`, d.auth, { fullName: 'Bala Musa' })).body.language).toBe('en');
  });

  it('decides the language of order emails, with prices unchanged', async () => {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { siteUrl: 'https://shop.example.test', contact: { bankName: 'Test Bank', accountName: 'Textiles Ltd', accountNumber: '0123456789' } });
    await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
    const mailer = new Outbox();
    const d = new Dispatcher(ctx.db, { secretBox: null, urlPolicy: { allowHttp: false, allowPrivate: false }, consumers: [orderEmailConsumer(mailer)] });
    const drain = async () => { for (let i = 0; i < 40; i++) if ((await d.runOnce(new Date(Date.now() + 3_600_000))) === 0) return; };

    const subjects: Record<string, string> = {};
    for (const language of ['fr', 'ha', 'en'] as const) {
      const c = await shopper(`mail-${uniq()}@example.test`);
      await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Amina Yusuf', language });
      const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Amina Yusuf', phone: '+2348011111111', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
      const order = await call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...c.auth, 'idempotency-key': crypto.randomUUID() }, {
        lines: [{ variantId: s.w.fabric.variantId, quantity: '2' }], addressId: addr.body.id, paymentMethod: 'bank_transfer',
      });
      await drain();
      const mail = mailer.sent.find((m) => m.to === c.email)!;
      subjects[language] = mail.subject;
      expect(mail.text).toContain('₦8,526.08');
      expect(mail.text).toContain('0123456789');
      expect(mail.text).toContain(order.body.orderNo);
    }
    expect(subjects.fr).toMatch(/^Nous avons bien reçu votre commande /);
    expect(subjects.ha).toMatch(/^Mun karɓi odarku /);
    expect(subjects.en).toMatch(/^We have your order /);
  });
});
