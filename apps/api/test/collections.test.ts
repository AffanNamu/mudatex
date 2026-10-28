import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Mail, Mailer } from '../src/notify/mailer.js';
import { runCollections } from '../src/trade/collections.js';
import { call, setupApp, staff } from './helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

class Outbox implements Mailer {
  sent: Mail[] = [];
  failNext = 0;
  async send(m: Mail) {
    if (this.failNext > 0) { this.failNext--; throw new Error('mail down'); }
    this.sent.push(m);
  }
  to(email: string) { return this.sent.filter((m) => m.to === email); }
}

let ctx: Awaited<ReturnType<typeof setupApp>>;
let mailer: Outbox;
beforeAll(async () => { mailer = new Outbox(); ctx = await setupApp({}, { mailer }); });
afterAll(async () => { await ctx.close(); });

const day = (n: number) => new Date(Date.now() + n * 86_400_000);

async function ready(language = 'en') {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { siteUrl: 'https://shop.example.test', contact: { bankName: 'Test Bank', accountName: 'Textiles Ltd', accountNumber: '0123456789' } });
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  const list = await call(ctx.app, 'POST', '/v1/pricing/price-lists', s.a, { legalEntityId: s.w.ng, name: 'Wholesale NGN', currency: 'NGN' });
  await call(ctx.app, 'PUT', `/v1/pricing/price-lists/${list.body.id}/items`, { ...s.a }, { variantId: s.w.fabric.variantId, unitPrice: '3000', taxCodeId: s.w.vat });
  const c = await shopper(`col-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Hajiya Zainab', language });
  const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'Shop', recipient: 'Zainab', phone: '+2348011111111', line1: '1 Kwari', city: 'Kano', state: 'Kano', countryCode: 'NG' });
  await call(ctx.app, 'POST', `/shop/${s.slug}/me/trade`, c.auth, { businessName: 'Zainab Fabrics' });
  const queue = await call(ctx.app, 'GET', '/v1/trade-accounts', s.a);
  const tradeId = queue.body.find((t: any) => t.email === c.email).id as string;
  const decide = (body: Record<string, unknown>) => call(ctx.app, 'POST', `/v1/trade-accounts/${tradeId}/decision`, s.a, body);
  await decide({ status: 'approved', priceListId: list.body.id, creditLimitMinor: 50_000_000, paymentTermsDays: 30 });
  const order = async (qty = '3') => {
    const r = await call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...c.auth, 'idempotency-key': crypto.randomUUID() }, { lines: [{ variantId: s.w.fabric.variantId, quantity: qty }], addressId: addr.body.id, paymentMethod: 'account' });
    expect(r.status).toBe(201);
    return r.body as { id: string; orderNo: string; totalMinor: number };
  };
  const status = async () => (await ctx.db.query('SELECT status, held_automatically AS held, note FROM trade_accounts WHERE id = $1', [tradeId])).rows[0] as { status: string; held: boolean; note: string | null };
  const round = (days: number) => runCollections(ctx.db, mailer, day(days), { organizationId: s.w.org.organizationId });
  const pay = (orderId: string, amountMinor: number) => call(ctx.app, 'POST', `/v1/sales-orders/${orderId}/payments`, s.a, { method: 'bank_transfer', reference: `COL-${uniq()}`, amountMinor });
  return { s, c, tradeId, decide, order, status, round, pay };
}

describe('collections', () => {
  it('reminds once per stage as an invoice nears and passes its due date, then holds the business and releases it when paid', async () => {
    const r = await ready();
    const o = await r.order();   // 10,675.00, due in 30 days
    const mine = () => mailer.to(r.c.email);

    expect((await r.round(26)).reminders).toBe(0);   // four days before the due date: too early
    await r.round(27);
    expect(mine().map((m) => m.subject)).toEqual([`Payment due soon for ${o.orderNo}`]);
    expect(mine()[0]!.text).toContain('₦10,675.00');
    expect(mine()[0]!.text).toContain('0123456789');
    expect((await r.round(28)).reminders).toBe(0);   // the same stage is never sent twice
    await r.round(31);
    await r.round(31);
    await r.round(37);
    await r.round(44);
    expect(mine().map((m) => m.subject)).toEqual([
      `Payment due soon for ${o.orderNo}`, `Payment overdue for ${o.orderNo}`,
      `Reminder: ${o.orderNo} is a week overdue`, `Second reminder: ${o.orderNo} is two weeks overdue`,
    ]);
    expect(await r.status()).toMatchObject({ status: 'approved', held: false });

    // Thirty days overdue: on hold, once, with an explanation.
    expect(await r.round(60)).toMatchObject({ holds: 1 });
    expect(await r.round(60)).toMatchObject({ holds: 0, reminders: 0 });
    expect(await r.status()).toMatchObject({ status: 'suspended', held: true, note: expect.stringContaining(o.orderNo) });
    expect(mine().at(-1)!.subject).toBe('Your trade account is on hold');
    expect(mine()).toHaveLength(5);
    // While held: no trade prices and no orders on account.
    const basket = await call(ctx.app, 'POST', `/shop/${r.s.slug}/basket`, r.c.auth, { lines: [{ variantId: r.s.w.fabric.variantId, quantity: '1' }] });
    expect(basket.body.trade).toBeNull();
    const refused = await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders`, { ...r.c.auth, 'idempotency-key': crypto.randomUUID() }, { lines: [{ variantId: r.s.w.fabric.variantId, quantity: '1' }], addressId: (await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/addresses`, r.c.auth)).body[0].id, paymentMethod: 'account' });
    expect(refused.status).toBe(422);

    // Paying part of it keeps the hold; paying all of it lifts it.
    expect((await r.pay(o.id, 500_000)).status).toBe(200);
    expect((await r.round(61)).releases).toBe(0);
    expect((await r.pay(o.id, o.totalMinor - 500_000)).status).toBe(200);
    expect((await r.round(62)).releases).toBe(1);
    expect(await r.status()).toMatchObject({ status: 'approved', held: false, note: null });
    expect((await call(ctx.app, 'POST', `/shop/${r.s.slug}/basket`, r.c.auth, { lines: [{ variantId: r.s.w.fabric.variantId, quantity: '1' }] })).body.trade).not.toBeNull();
    const audit = await ctx.db.query(`SELECT action FROM audit_log WHERE entity_id = $1 AND action LIKE 'trade.auto_%' ORDER BY id`, [r.tradeId]);
    expect(audit.rows.map((a) => a.action)).toEqual(['trade.auto_hold', 'trade.auto_release']);
  });

  it('writes in the customer\'s language', async () => {
    const fr = await ready('fr');
    const o = await fr.order();
    await fr.round(31);
    expect(mailer.to(fr.c.email)[0]!.subject).toBe(`Paiement en retard pour ${o.orderNo}`);
    expect(mailer.to(fr.c.email)[0]!.text).toContain('Bonjour Hajiya Zainab,');
    const ha = await ready('ha');
    const o2 = await ha.order();
    await ha.round(31);
    expect(mailer.to(ha.c.email)[0]!.subject).toBe(`Biyan ${o2.orderNo} ya wuce lokaci`);
  });

  it('retries a reminder the email service dropped, and still applies holds when email is not set up', async () => {
    const r = await ready();
    const o = await r.order();
    mailer.failNext = 1;
    expect((await r.round(31)).reminders).toBe(0);
    expect(mailer.to(r.c.email)).toHaveLength(0);
    expect((await r.round(31)).reminders).toBe(1);   // the failed attempt left no record, so the next round sends it
    expect(mailer.to(r.c.email)).toHaveLength(1);

    const quiet = await ready();
    await quiet.order();
    const result = await runCollections(ctx.db, undefined, day(60), { organizationId: quiet.s.w.org.organizationId });
    expect(result).toEqual({ reminders: 0, holds: 1, releases: 0 });
    expect(mailer.to(quiet.c.email)).toHaveLength(0);
    expect(o.orderNo).toBeTruthy();
  });

  it('never holds a business whose automatic hold is switched off, and never releases a hold a person set', async () => {
    const off = await ready();
    await off.decide({ status: 'approved', holdAfterDays: 0 });
    await off.order();
    expect((await off.round(90)).holds).toBe(0);
    expect(await off.status()).toMatchObject({ status: 'approved' });

    const manual = await ready();
    await manual.order();
    await manual.decide({ status: 'suspended', note: 'Cheque bounced' });
    await manual.round(90);
    expect(await manual.status()).toMatchObject({ status: 'suspended', held: false, note: 'Cheque bounced' });
    // A person re-approving puts the hold rule back in charge (and clears the automatic flag).
    await manual.decide({ status: 'approved' });
    await manual.round(90);
    expect(await manual.status()).toMatchObject({ status: 'suspended', held: true });
    await manual.decide({ status: 'approved', holdAfterDays: 0 });
    expect(await manual.status()).toMatchObject({ status: 'approved', held: false });
  });
});

describe('the collections desk', () => {
  it('shows who owes what by age, held businesses first, only to people who manage trade accounts', async () => {
    const r = await ready();
    const o = await r.order();
    const view = await call(ctx.app, 'GET', '/v1/collections', r.s.a);
    expect(view.status).toBe(200);
    const mine = view.body.accounts.find((a: any) => a.id === r.tradeId);
    expect(mine).toMatchObject({ businessName: 'Zainab Fabrics', status: 'approved', outstandingMinor: 1067500, overdueMinor: 0, oldestOverdueDays: 0, invoices: [{ orderNo: o.orderNo, outstandingMinor: 1067500, daysOverdue: -30 }] });
    const ngn = view.body.totals.find((t: any) => t.currency === 'NGN');
    expect(ngn.outstandingMinor).toBeGreaterThanOrEqual(1067500);
    expect(ngn.buckets.current).toBeGreaterThanOrEqual(1067500);

    // Back-date the due date to see ageing and the held-first ordering.
    await ctx.db.query(`UPDATE sales_orders SET due_on = (CURRENT_DATE - 45) WHERE id = $1`, [o.id]);
    await r.round(0);
    const later = (await call(ctx.app, 'GET', '/v1/collections', r.s.a)).body;
    const held = later.accounts.find((a: any) => a.id === r.tradeId);
    expect(held).toMatchObject({ status: 'suspended', heldAutomatically: true, overdueMinor: 1067500, oldestOverdueDays: 45 });
    expect(later.accounts[0].status).toBe('suspended');
    expect(later.totals.find((t: any) => t.currency === 'NGN').buckets.d31_60).toBeGreaterThanOrEqual(1067500);

    const outsider = await staff(ctx.app, r.s.a, ['inventory.read'], { type: 'legal_entity', id: r.s.w.ng });
    expect((await call(ctx.app, 'GET', '/v1/collections', outsider.auth)).body.accounts).toEqual([]);   // sees nothing
    const other = await ready();
    expect((await call(ctx.app, 'GET', '/v1/collections', other.s.a)).body.accounts.find((a: any) => a.id === r.tradeId)).toBeUndefined();   // another company's desk never shows it
  });

  it('lets a person send a reminder, at most once a day, only when something is owed', async () => {
    const r = await ready();
    const send = (auth = r.s.a) => call(ctx.app, 'POST', `/v1/trade-accounts/${r.tradeId}/reminder`, auth);
    expect((await send()).status).toBe(409);   // nothing owing yet
    const o = await r.order();
    const sent = await send();
    expect(sent).toMatchObject({ status: 200, body: { sentTo: r.c.email, invoices: 1 } });
    expect(mailer.to(r.c.email).at(-1)!.subject).toBe('Reminder: balance owing on your trade account');
    expect(mailer.to(r.c.email).at(-1)!.text).toContain(o.orderNo);
    expect((await send()).status).toBe(409);   // once a day
    const nobody = await staff(ctx.app, r.s.a, ['inventory.read'], { type: 'legal_entity', id: r.s.w.ng });
    expect((await send(nobody.auth)).status).toBe(403);
    expect((await call(ctx.app, 'POST', `/v1/trade-accounts/${crypto.randomUUID()}/reminder`, r.s.a)).status).toBe(404);
  });
});
