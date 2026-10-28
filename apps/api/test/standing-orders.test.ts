import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Mail, Mailer } from '../src/notify/mailer.js';
import { nextAfter, nextOccurrence, runStandingOrders } from '../src/trade/standing-orders.js';
import { call, setupApp, staff } from './helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

class Outbox implements Mailer { sent: Mail[] = []; async send(m: Mail) { this.sent.push(m); } to(e: string) { return this.sent.filter((m) => m.to === e); } }

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

const day = (n: number) => new Date(Date.now() + n * 86_400_000);
const date = (n: number) => day(n).toISOString().slice(0, 10);
const mailer = new Outbox();

async function ready(language = 'en') {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  const list = await call(ctx.app, 'POST', '/v1/pricing/price-lists', s.a, { legalEntityId: s.w.ng, name: 'Wholesale NGN', currency: 'NGN' });
  const setPrice = (unitPrice: string) => call(ctx.app, 'PUT', `/v1/pricing/price-lists/${list.body.id}/items`, s.a, { variantId: s.w.fabric.variantId, unitPrice, taxCodeId: s.w.vat });
  await setPrice('3000');
  const c = await shopper(`so-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Hajiya Zainab', language });
  const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'Shop', recipient: 'Zainab', phone: '+2348011111111', line1: '1 Kwari', city: 'Kano', state: 'Kano', countryCode: 'NG' });
  await call(ctx.app, 'POST', `/shop/${s.slug}/me/trade`, c.auth, { businessName: 'Zainab Fabrics' });
  const queue = await call(ctx.app, 'GET', '/v1/trade-accounts', s.a);
  const tradeId = queue.body.find((t: any) => t.email === c.email).id as string;
  const decide = (body: Record<string, unknown>) => call(ctx.app, 'POST', `/v1/trade-accounts/${tradeId}/decision`, s.a, body);
  await decide({ status: 'approved', priceListId: list.body.id, creditLimitMinor: 500_000_000, paymentTermsDays: 30 });
  const order = async (qty = '3') => (await call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...c.auth, 'idempotency-key': crypto.randomUUID() }, { lines: [{ variantId: s.w.fabric.variantId, quantity: qty }], addressId: addr.body.id, paymentMethod: 'account' })).body as { orderNo: string };
  const create = (body: Record<string, unknown>, who = c) => call(ctx.app, 'POST', `/shop/${s.slug}/me/standing-orders`, who.auth, { addressId: addr.body.id, frequency: 'weekly', firstRunOn: date(0), ...body });
  const orders = async () => (await ctx.db.query(`SELECT order_no, note, total_minor::float8 AS total, status, payment_method FROM sales_orders WHERE customer_id = (SELECT id FROM customers WHERE email = $1) ORDER BY placed_at`, [c.email])).rows;
  const run = (n = 0) => runStandingOrders(ctx.db, mailer, day(n), { organizationId: s.w.org.organizationId });
  const soRow = async (id: string) => (await ctx.db.query(`SELECT status, to_char(next_run_on, 'YYYY-MM-DD') AS next, failures_in_row AS failures, paused_reason AS reason FROM standing_orders WHERE id = $1`, [id])).rows[0];
  return { s, c, tradeId, decide, order, create, orders, run, soRow, setPrice, addressId: addr.body.id as string };
}

describe('schedule arithmetic', () => {
  it('steps weekly, fortnightly and monthly, and never queues up missed days', () => {
    expect(nextOccurrence('2026-01-26', 'weekly')).toBe('2026-02-02');
    expect(nextOccurrence('2026-01-26', 'fortnightly')).toBe('2026-02-09');
    expect(nextOccurrence('2026-01-28', 'monthly')).toBe('2026-02-28');
    expect(nextOccurrence('2026-12-15', 'monthly')).toBe('2027-01-15');
    expect(nextAfter('2026-01-01', '2026-03-01', 'weekly')).toBe('2026-03-05');   // one order for a missed stretch, then the next future date
    expect(nextAfter('2026-03-01', '2026-03-01', 'weekly')).toBe('2026-03-08');
  });
});

describe('standing orders', () => {
  it('place an ordinary order when due, at that day\'s trade prices, once, and move to the next date', async () => {
    const r = await ready();
    const first = await r.order('3');
    const made = await r.create({ fromOrderNo: first.orderNo });
    expect(made).toMatchObject({ status: 201, body: { status: 'active', frequency: 'weekly', nextRunOn: date(0), paymentMethod: 'account', lines: [{ sku: expect.any(String), quantity: '3' }], sourceOrderNo: first.orderNo } });

    expect(await r.run(-1)).toEqual({ placed: 0, failed: 0, paused: 0 });   // not due yet
    await r.setPrice('2500');                                                // the price list moves; the standing order follows it
    expect(await r.run(0)).toEqual({ placed: 1, failed: 0, paused: 0 });
    const rows = await r.orders();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ status: 'confirmed', payment_method: 'account', note: 'Standing order (weekly)', total: 3 * 2500 * 107.5 + 100000 });   // 3 × 2,500 + 7.5% + 1,000 delivery, in kobo
    expect((await r.soRow(made.body.id)).next).toBe(date(7));
    expect(await r.run(0)).toEqual({ placed: 0, failed: 0, paused: 0 });    // nothing more today
    const listed = await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/standing-orders`, r.c.auth);
    expect(listed.body[0]).toMatchObject({ nextRunOn: date(7), lastRun: { runOn: date(0), outcome: 'placed', orderNo: rows[1].order_no } });
  });

  it('cannot place the same day twice, even if the schedule is wound back', async () => {
    const r = await ready();
    const o = await r.order('2');
    const made = await r.create({ fromOrderNo: o.orderNo });
    await r.run(0);
    await ctx.db.query(`UPDATE standing_orders SET next_run_on = CURRENT_DATE WHERE id = $1`, [made.body.id]);
    await r.run(0);
    expect(await r.orders()).toHaveLength(2);   // the second run found the first run's order
  });

  it('runs a long-missed schedule once, not once for every missed day', async () => {
    const r = await ready();
    const o = await r.order('1');
    const made = await r.create({ fromOrderNo: o.orderNo });
    await ctx.db.query(`UPDATE standing_orders SET next_run_on = CURRENT_DATE - 30 WHERE id = $1`, [made.body.id]);
    expect((await r.run(0)).placed).toBe(1);
    expect(await r.orders()).toHaveLength(2);
    const next = (await r.soRow(made.body.id)).next as string;
    expect(next > date(0) && next <= date(7)).toBe(true);
  });

  it('tell the buyer when one cannot be placed, in their language, and pause themselves after three failures in a row', async () => {
    const r = await ready('fr');
    const o = await r.order('1');
    const made = await r.create({ fromOrderNo: o.orderNo });
    await ctx.db.query(`UPDATE standing_order_lines SET quantity = 9999999 WHERE standing_order_id = $1`, [made.body.id]);   // far more than any shelf holds
    expect(await r.run(0)).toEqual({ placed: 0, failed: 1, paused: 0 });
    expect(await r.soRow(made.body.id)).toMatchObject({ status: 'active', failures: 1, next: date(7) });
    const mail = mailer.to(r.c.email).at(-1)!;
    expect(mail.subject).toBe('Votre commande permanente n’a pas pu être passée');
    expect(mail.text).toContain('Certains articles ne sont plus disponibles dans la quantité demandée');
    expect(mail.text).toContain(`Nous réessaierons le ${date(7)}`);
    await r.run(7);
    const third = await r.run(14);
    expect(third).toEqual({ placed: 0, failed: 1, paused: 1 });
    expect(await r.soRow(made.body.id)).toMatchObject({ status: 'paused', failures: 3, reason: expect.stringContaining('Paused after 3 failed attempts') });
    expect(mailer.to(r.c.email).at(-1)!.text).toContain('suspendue');
    expect(await r.run(21)).toEqual({ placed: 0, failed: 0, paused: 0 });   // a paused standing order does nothing
    expect(await r.orders()).toHaveLength(1);
  });

  it('are not placed while the trade account is on hold, rather than falling back to shop prices', async () => {
    const r = await ready();
    const o = await r.order('1');
    const made = await r.create({ fromOrderNo: o.orderNo });
    await r.decide({ status: 'suspended', note: 'hold' });
    expect((await r.run(0)).failed).toBe(1);
    expect(await r.orders()).toHaveLength(1);
    expect(mailer.to(r.c.email).at(-1)!.text).toContain('trade account is on hold');
    expect((await r.soRow(made.body.id)).failures).toBe(1);
  });

  it('can be paused, resumed (without running the days in between) and cancelled by the buyer or by staff', async () => {
    const r = await ready();
    const o = await r.order('1');
    const made = (await r.create({ fromOrderNo: o.orderNo, firstRunOn: date(3) })).body;
    const act = (what: string, who = r.c) => call(ctx.app, 'POST', `/shop/${r.s.slug}/me/standing-orders/${made.id}/${what}`, who.auth);
    expect((await act('pause')).body.status).toBe('paused');
    await ctx.db.query(`UPDATE standing_orders SET next_run_on = CURRENT_DATE - 20 WHERE id = $1`, [made.id]);
    expect((await r.run(0)).placed).toBe(0);
    const resumed = await act('resume');
    expect(resumed.body.status).toBe('active');
    expect(resumed.body.nextRunOn > date(0)).toBe(true);   // it picks up from the next future date
    const other = await shopper(`other-${uniq()}@example.test`);
    await call(ctx.app, 'POST', `/shop/${r.s.slug}/me`, other.auth, { fullName: 'Someone Else' });
    expect((await act('cancel', other)).status).toBe(404);

    const desk = await call(ctx.app, 'GET', '/v1/standing-orders?status=active', r.s.a);
    expect(desk.body).toEqual([expect.objectContaining({ id: made.id, businessName: 'Zainab Fabrics', frequency: 'weekly' })]);
    const nobody = await staff(ctx.app, r.s.a, ['inventory.read'], { type: 'legal_entity', id: r.s.w.ng });
    expect((await call(ctx.app, 'GET', '/v1/standing-orders', nobody.auth)).body).toEqual([]);
    expect((await call(ctx.app, 'POST', `/v1/standing-orders/${made.id}/pause`, nobody.auth)).status).toBe(403);
    expect((await call(ctx.app, 'POST', `/v1/standing-orders/${made.id}/pause`, r.s.a)).body.status).toBe('paused');
    expect((await call(ctx.app, 'POST', `/v1/standing-orders/${made.id}/cancel`, r.s.a)).body.status).toBe('cancelled');
    expect((await act('resume')).status).toBe(409);
  });

  it('refuse bad schedules, other people\'s orders and addresses, non-trade buyers, and too many', async () => {
    const r = await ready();
    const o = await r.order('1');
    expect((await r.create({ fromOrderNo: o.orderNo, firstRunOn: date(-1) })).status).toBe(422);
    expect((await r.create({ fromOrderNo: o.orderNo, frequency: 'monthly', firstRunOn: '2031-01-31' })).status).toBe(422);
    expect((await r.create({ fromOrderNo: o.orderNo, firstRunOn: date(500) })).status).toBe(422);
    expect((await r.create({ fromOrderNo: o.orderNo, addressId: crypto.randomUUID() })).status).toBe(422);
    expect((await r.create({ fromOrderNo: 'SO-999999' })).status).toBe(404);
    expect((await r.create({ fromOrderNo: o.orderNo, frequency: 'daily' })).status).toBe(400);
    expect((await r.create({ fromOrderNo: o.orderNo, couponCode: 'X' })).status).toBe(400);
    const retail = await shopper(`retail-${uniq()}@example.test`);
    await call(ctx.app, 'POST', `/shop/${r.s.slug}/me`, retail.auth, { fullName: 'Retail Buyer' });
    expect((await r.create({ fromOrderNo: o.orderNo }, retail)).status).toBe(409);
    for (let i = 0; i < 10; i++) expect((await r.create({ fromOrderNo: o.orderNo })).status).toBe(201);
    const eleventh = await r.create({ fromOrderNo: o.orderNo });
    expect(eleventh).toMatchObject({ status: 409, body: { message: 'You can have up to 10 standing orders' } });
  });
});
