import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/events/dispatcher.js';
import type { Mail, Mailer } from '../src/notify/mailer.js';
import { quoteEmailConsumer } from '../src/notify/quote-emails.js';
import { call, setupApp, staff } from './helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

class Outbox implements Mailer { sent: Mail[] = []; async send(m: Mail) { this.sent.push(m); } }

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

const dayFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function ready(language = 'en') {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { siteUrl: 'https://shop.example.test' });
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  const list = await call(ctx.app, 'POST', '/v1/pricing/price-lists', s.a, { legalEntityId: s.w.ng, name: 'Wholesale NGN', currency: 'NGN' });
  const setPrice = (unitPrice: string) => call(ctx.app, 'PUT', `/v1/pricing/price-lists/${list.body.id}/items`, s.a, { variantId: s.w.fabric.variantId, unitPrice, taxCodeId: s.w.vat });
  await setPrice('3000');
  const c = await shopper(`qt-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Hajiya Zainab', language });
  const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'Shop', recipient: 'Zainab', phone: '+2348011111111', line1: '1 Kwari', city: 'Kano', state: 'Kano', countryCode: 'NG' });
  await call(ctx.app, 'POST', `/shop/${s.slug}/me/trade`, c.auth, { businessName: 'Zainab Fabrics' });
  const queue = await call(ctx.app, 'GET', '/v1/trade-accounts', s.a);
  const tradeId = queue.body.find((t: any) => t.email === c.email).id as string;
  const decide = (body: Record<string, unknown>) => call(ctx.app, 'POST', `/v1/trade-accounts/${tradeId}/decision`, s.a, body);
  await decide({ status: 'approved', priceListId: list.body.id, creditLimitMinor: 500_000_000, paymentTermsDays: 30 });
  const post = (path: string, body: unknown, auth = s.a) => call(ctx.app, 'POST', `/v1${path}`, { ...auth, 'idempotency-key': crypto.randomUUID() }, body);
  const quote = (lines: unknown[], extra: Record<string, unknown> = {}, auth = s.a) => post('/quotes', { tradeAccountId: tradeId, validUntil: dayFromNow(14), lines, ...extra }, auth);
  const accept = (quoteNo: string, body: Record<string, unknown> = {}, who = c, headers: Record<string, string> = {}) =>
    call(ctx.app, 'POST', `/shop/${s.slug}/me/quotes/${quoteNo}/accept`, { ...who.auth, 'idempotency-key': crypto.randomUUID(), ...headers }, { addressId: addr.body.id, paymentMethod: 'account', ...body });
  return { s, c, tradeId, decide, post, quote, accept, setPrice, addressId: addr.body.id as string, line: (quantity: string, unitPrice?: string) => ({ variantId: s.w.fabric.variantId, quantity, ...(unitPrice ? { unitPrice } : {}) }) };
}

describe('quotes: pricing and who may price', () => {
  it('prices from the trade list or an agreed price, with the shop\'s tax and rounding, and numbers them', async () => {
    const r = await ready();
    const list = await r.quote([r.line('10')]);
    expect(list.status).toBe(201);
    expect(list.body).toMatchObject({ status: 'draft', quoteNo: expect.stringMatching(/^QT-\d{6}$/), subtotalMinor: 3225000, taxMinor: 225000, lines: [{ unitPrice: '3000', listPrice: '3000', totalMinor: 3225000 }] });   // 10 × 3,000 + 7.5% VAT
    const agreed = await r.quote([r.line('10', '2800')]);
    expect(agreed.body).toMatchObject({ subtotalMinor: 3010000, lines: [{ unitPrice: '2800', listPrice: '3000' }] });   // 28,000 + 7.5% = 30,100.00
    const higher = await r.quote([r.line('10', '3100')]);
    expect(higher.status).toBe(201);
  });

  it('needs the override permission to go below the trade price, and manage rights to quote at all', async () => {
    const r = await ready();
    const clerk = await staff(ctx.app, r.s.a, ['quotes.manage'], { type: 'legal_entity', id: r.s.w.ng });
    expect((await r.quote([r.line('10', '2800')], {}, clerk.auth)).status).toBe(403);
    expect((await r.quote([r.line('10', '3000')], {}, clerk.auth)).status).toBe(201);
    const closer = await staff(ctx.app, r.s.a, ['quotes.manage', 'quotes.price.override'], { type: 'legal_entity', id: r.s.w.ng });
    expect((await r.quote([r.line('10', '2800')], {}, closer.auth)).status).toBe(201);
    const nobody = await staff(ctx.app, r.s.a, ['catalog.read'], { type: 'legal_entity', id: r.s.w.ng });
    expect((await r.quote([r.line('1')], {}, nobody.auth)).status).toBe(403);
    expect((await call(ctx.app, 'GET', '/v1/quotes', nobody.auth)).body).toEqual([]);
    expect((await call(ctx.app, 'GET', '/v1/quotes/accounts', nobody.auth)).body).toEqual([]);
    expect((await call(ctx.app, 'GET', '/v1/quotes/accounts', clerk.auth)).body).toContainEqual(expect.objectContaining({ id: r.tradeId, businessName: 'Zainab Fabrics' }));
  });

  it('refuses bad requests: past or distant dates, repeated products, odd prices, unapproved businesses', async () => {
    const r = await ready();
    expect((await r.quote([r.line('1')], { validUntil: dayFromNow(-1) })).status).toBe(422);
    expect((await r.quote([r.line('1')], { validUntil: dayFromNow(91) })).status).toBe(422);
    expect((await r.quote([r.line('1'), r.line('2')])).status).toBe(422);
    expect((await r.quote([r.line('1', '0')])).status).toBe(422);
    expect((await r.quote([r.line('1', '10.12345')])).status).toBe(400);
    expect((await r.quote([])).status).toBe(400);
    await r.decide({ status: 'suspended', note: 'hold' });
    expect((await r.quote([r.line('1')])).status).toBe(409);
  });

  it('lets a draft be reworked but not a sent quote, and sends only what is complete', async () => {
    const r = await ready();
    const d = await r.quote([r.line('10')]);
    const id = d.body.id as string;
    const put = (body: unknown) => call(ctx.app, 'PUT', `/v1/quotes/${id}`, { ...r.s.a, 'idempotency-key': crypto.randomUUID() }, body);
    expect((await put({ lines: [r.line('20', '2900')], note: 'Bulk rate' })).body).toMatchObject({ note: 'Bulk rate', lines: [{ quantity: '20', unitPrice: '2900' }], subtotalMinor: 6235000 });   // 58,000 + 7.5%
    expect((await r.post(`/quotes/${id}/send`, {})).body.status).toBe('sent');
    expect((await put({ note: 'too late' })).status).toBe(409);
    expect((await r.post(`/quotes/${id}/send`, {})).status).toBe(409);
  });
});

describe('quotes: the buyer\'s side', () => {
  it('is emailed when sent, is visible only to its buyer once sent, and is accepted into an order at exactly the quoted prices', async () => {
    const r = await ready();
    const mailer = new Outbox();
    const d = new Dispatcher(ctx.db, { secretBox: null, urlPolicy: { allowHttp: false, allowPrivate: false }, consumers: [quoteEmailConsumer(mailer)] });
    const drain = async () => { for (let i = 0; i < 2000; i++) if ((await d.runOnce(new Date(Date.now() + 3_600_000))) === 0) return; };

    const q = (await r.quote([r.line('10', '2800')], { note: 'Valid for the Eid rush' })).body;
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/quotes/${q.quoteNo}`, r.c.auth)).status).toBe(404);   // still a draft
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/quotes`, r.c.auth)).body).toEqual([]);
    await r.post(`/quotes/${q.id}/send`, {});
    await drain();
    const mail = mailer.sent.find((m) => m.to === r.c.email)!;
    expect(mail.subject).toBe(`Your quote ${q.quoteNo} from Test Shop`);
    expect(mail.text).toContain('₦30,100.00');
    expect(mail.text).toContain(`https://shop.example.test/quotes/${q.quoteNo}`);
    expect(mail.text).toContain('Valid for the Eid rush');

    const mine = await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/quotes`, r.c.auth);
    expect(mine.body).toEqual([expect.objectContaining({ quoteNo: q.quoteNo, status: 'sent', totalMinor: 3010000, lineCount: 1 })]);
    const detail = await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/quotes/${q.quoteNo}`, r.c.auth);
    expect(detail.body).toMatchObject({ status: 'sent', note: 'Valid for the Eid rush', lines: [{ unitPrice: '2800', quantity: '10' }] });
    expect(detail.body.createdBy).toBeUndefined();
    const stranger = await shopper(`other-${uniq()}@example.test`);
    await call(ctx.app, 'POST', `/shop/${r.s.slug}/me`, stranger.auth, { fullName: 'Someone Else' });
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/quotes/${q.quoteNo}`, stranger.auth)).status).toBe(404);

    // The trade price list moves on; the quote does not.
    await r.setPrice('5000');
    const key = crypto.randomUUID();
    const accepted = await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/quotes/${q.quoteNo}/accept`, { ...r.c.auth, 'idempotency-key': key }, { addressId: r.addressId, paymentMethod: 'account', note: 'Please wrap' });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ status: 'confirmed', paymentMethod: 'account', subtotalMinor: 3010000, deliveryFeeMinor: 100000, totalMinor: 3110000, lines: [{ quantity: '10', unitPrice: '2800' }] });
    expect(accepted.body.events[0].note).toContain(`Placed from quote ${q.quoteNo}`);
    const again = await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/quotes/${q.quoteNo}/accept`, { ...r.c.auth, 'idempotency-key': key }, { addressId: r.addressId, paymentMethod: 'account', note: 'Please wrap' });
    expect(again).toMatchObject({ status: 200, body: { orderNo: accepted.body.orderNo } });   // a retry meets the same order
    expect((await r.accept(q.quoteNo)).status).toBe(409);                                       // a second acceptance does not
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/quotes/${q.quoteNo}`, r.c.auth)).body).toMatchObject({ status: 'accepted', orderNo: accepted.body.orderNo });
    expect((await call(ctx.app, 'GET', `/v1/quotes/${q.id}`, r.s.a)).body).toMatchObject({ status: 'accepted', orderNo: accepted.body.orderNo });
    // Stock is held for the order.
    const res = await ctx.db.query(`SELECT count(*)::int AS n FROM stock_reservations WHERE reference_type = 'sales_order' AND reference_id = $1::text`, [accepted.body.id]);
    expect(res.rows[0].n).toBeGreaterThan(0);
  });

  it('can be paid by bank transfer instead of on account, and cannot be combined with a coupon', async () => {
    const r = await ready();
    const q = (await r.quote([r.line('2')])).body;
    await r.post(`/quotes/${q.id}/send`, {});
    expect((await r.accept(q.quoteNo, { couponCode: 'WELCOME10' })).status).toBe(400);
    const o = await r.accept(q.quoteNo, { paymentMethod: 'bank_transfer' });
    expect(o).toMatchObject({ status: 201, body: { status: 'pending_payment', paymentMethod: 'bank_transfer' } });
  });

  it('can be declined by the buyer or cancelled by staff, and then cannot be accepted', async () => {
    const r = await ready();
    const a = (await r.quote([r.line('2')])).body;
    const b = (await r.quote([r.line('3')])).body;
    await r.post(`/quotes/${a.id}/send`, {});
    await r.post(`/quotes/${b.id}/send`, {});
    expect((await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/quotes/${a.quoteNo}/decline`, r.c.auth)).body.status).toBe('declined');
    expect((await r.post(`/quotes/${b.id}/cancel`, {})).body.status).toBe('cancelled');
    expect((await r.accept(a.quoteNo)).status).toBe(409);
    expect((await r.accept(b.quoteNo)).status).toBe(409);
    expect((await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/quotes/${a.quoteNo}/decline`, r.c.auth)).status).toBe(409);
  });

  it('expires on its date, is refused when stock is short or the account is on hold, and speaks the buyer\'s language', async () => {
    const r = await ready();
    const old = (await r.quote([r.line('2')])).body;
    await r.post(`/quotes/${old.id}/send`, {});
    await ctx.db.query(`UPDATE quotes SET valid_until = CURRENT_DATE - 1 WHERE id = $1`, [old.id]);
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/quotes/${old.quoteNo}`, r.c.auth)).body.status).toBe('expired');
    expect((await call(ctx.app, 'GET', '/v1/quotes?status=expired', r.s.a)).body.map((x: any) => x.quoteNo)).toContain(old.quoteNo);
    const expired = await r.accept(old.quoteNo, {}, r.c, { 'accept-language': 'fr' });
    expect(expired).toMatchObject({ status: 409, body: { message: 'Ce devis a expiré' } });

    const big = (await r.quote([r.line('9999999')])).body;
    await r.post(`/quotes/${big.id}/send`, {});
    expect((await r.accept(big.quoteNo)).status).toBe(409);   // not enough stock
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/quotes/${big.quoteNo}`, r.c.auth)).body.status).toBe('sent');   // …and the quote stays open

    const held = (await r.quote([r.line('2')])).body;
    await r.post(`/quotes/${held.id}/send`, {});
    await r.decide({ status: 'suspended' });
    const refused = await r.accept(held.quoteNo, { paymentMethod: 'bank_transfer' }, r.c, { 'accept-language': 'ha' });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('asusun ɗan kasuwanku');
  });

  it('does not send a quote to a business that is on hold, and writes the email in the buyer\'s language', async () => {
    const fr = await ready('fr');
    const mailer = new Outbox();
    const d = new Dispatcher(ctx.db, { secretBox: null, urlPolicy: { allowHttp: false, allowPrivate: false }, consumers: [quoteEmailConsumer(mailer)] });
    const q = (await fr.quote([fr.line('2')])).body;
    await fr.post(`/quotes/${q.id}/send`, {});
    for (let i = 0; i < 2000; i++) if ((await d.runOnce(new Date(Date.now() + 3_600_000))) === 0) break;
    expect(mailer.sent.find((m) => m.to === fr.c.email)!.subject).toBe(`Votre devis ${q.quoteNo} de Test Shop`);
    const q2 = (await fr.quote([fr.line('3')])).body;
    await fr.decide({ status: 'suspended' });
    expect((await fr.post(`/quotes/${q2.id}/send`, {})).status).toBe(409);
  });
});
