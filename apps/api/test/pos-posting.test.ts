import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/events/dispatcher.js';
import { posRevenueConsumer } from '../src/accounting/pos-posting.js';
import { priceLine } from '../src/domain/money.js';
import { call, newOrg, setupApp, staff } from './helpers.js';
import { buildWorld, cmd } from './inventory-helpers.js';
import { buildPosWorld, card, cash, openSession, sell, type PosWorld } from './pos-helpers.js';
import { trialBalance } from './accounting-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

const dispatcher = () => new Dispatcher(ctx.db, { secretBox: null, urlPolicy: { allowHttp: true, allowPrivate: true }, consumers: [posRevenueConsumer], jitter: () => 0.5 });
async function drain(d = dispatcher()) { for (let i = 0; i < 60; i++) if ((await d.runOnce()) === 0) return; }

interface Books { w: PosWorld; acc: Record<'cash' | 'card' | 'revenue' | 'tax', string>; accountant: Awaited<ReturnType<typeof staff>>; year: number }

async function setup(enable = true): Promise<Books> {
  const w = await buildPosWorld(ctx.app, await buildWorld(ctx.app, await newOrg(ctx.db)));
  const mk = async (code: string, name: string, type: string) => (await call(ctx.app, 'POST', '/v1/accounting/accounts', w.org.auth, { legalEntityId: w.ng, code, name, type })).body.id as string;
  const acc = { cash: await mk('1010', 'Cash clearing', 'asset'), card: await mk('1020', 'Card clearing', 'asset'), revenue: await mk('4000', 'Sales', 'revenue'), tax: await mk('2200', 'Sales tax payable', 'liability') };
  const year = new Date().getUTCFullYear();
  await call(ctx.app, 'POST', '/v1/accounting/periods', w.org.auth, { legalEntityId: w.ng, name: `FY${year}`, startDate: `${year - 1}-12-25`, endDate: `${year + 1}-01-05` });
  const accountant = await staff(ctx.app, w.org.auth, ['accounting.post', 'accounting.read', 'accounting.journal'], { type: 'legal_entity', id: w.ng });
  if (enable) await rules(w, { enabled: true, accounts: { cash: acc.cash, card: acc.card, salesRevenue: acc.revenue, salesTaxPayable: acc.tax } });
  await openSession(ctx.app, w.cashier.auth, w.reg1);
  return { w, acc, accountant, year };
}
const rules = (w: PosWorld, body: unknown) => call(ctx.app, 'PUT', `/v1/accounting/posting-rules/${w.ng}/pos`, w.org.auth, body);
const journalFor = async (sourceType: string, sourceId: string) => {
  const r = await ctx.db.query('SELECT id FROM journal_entries WHERE source_type = $1 AND source_id = $2', [sourceType, sourceId]);
  return r.rows.length ? (await call(ctx.app, 'GET', `/v1/accounting/journals/${r.rows[0].id}`, (await Promise.resolve(lastAuth)))) : null;
};
let lastAuth: { authorization: string };
const lines = (j: any) => j.body.lines.map((l: any) => [l.accountCode, l.debitMinor, l.creditMinor]);

describe('configuration', () => {
  it('is off by default and validated when turned on', async () => {
    const { w, acc } = await setup(false);
    expect((await call(ctx.app, 'GET', `/v1/accounting/posting-rules/${w.ng}/pos`, w.org.auth)).body).toEqual({ legalEntityId: w.ng, kind: 'pos_revenue', enabled: false, accounts: {} });
    expect((await rules(w, { enabled: true, accounts: { cash: acc.cash } })).status).toBe(422);                           // no revenue account
    expect((await rules(w, { enabled: true, accounts: { salesRevenue: acc.revenue } })).status).toBe(422);               // no payment account
    const foreign = (await call(ctx.app, 'POST', '/v1/accounting/accounts', w.org.auth, { legalEntityId: w.gh, code: '4000', name: 'GH sales', type: 'revenue' })).body.id;
    expect((await rules(w, { enabled: true, accounts: { cash: acc.cash, salesRevenue: foreign } })).status).toBe(422);    // another legal entity
    expect((await rules(w, { enabled: true, accounts: { cash: acc.cash, salesRevenue: acc.revenue } })).status).toBe(200);
    expect((await call(ctx.app, 'GET', `/v1/accounting/posting-rules/${w.ng}/pos`, w.org.auth)).body.enabled).toBe(true);
    expect((await call(ctx.app, 'PUT', `/v1/accounting/posting-rules/${w.ng}/pos`, w.cashier.auth, { enabled: false })).status).toBe(403);
  });
});

describe('sales', () => {
  it('draft nothing while rules are off, then a balanced draft once on', async () => {
    const { w, acc } = await setup(false);
    lastAuth = w.org.auth;
    const s1 = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.fabric.variantId, quantity: '1' }], [cash(376304)]);
    await drain();
    expect(await journalFor('pos_sale', s1.body.id)).toBeNull();
    expect((await call(ctx.app, 'GET', `/v1/accounting/posting-log?legalEntityId=${w.ng}`, w.org.auth)).body).toEqual([]);   // quiet: no noise for unused features

    await rules(w, { enabled: true, accounts: { cash: acc.cash, card: acc.card, salesRevenue: acc.revenue, salesTaxPayable: acc.tax } });
    const s2 = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.fabric.variantId, quantity: '1' }], [cash(376304, 400000)]);
    await drain();
    const j = await journalFor('pos_sale', s2.body.id);
    expect(j!.body).toMatchObject({ status: 'draft', sourceType: 'pos_sale', sourceId: s2.body.id, currency: 'NGN', createdBy: w.cashier.userId, description: `POS sale ${s2.body.receiptNumber}` });
    expect(lines(j)).toEqual([['1010', 376304, 0], ['4000', 0, 350050], ['2200', 0, 26254]]);
    expect(j!.body.lines.every((l: any) => l.locationId === w.shop)).toBe(true);
    expect((await call(ctx.app, 'GET', `/v1/accounting/posting-log?legalEntityId=${w.ng}`, w.org.auth)).body).toEqual([expect.objectContaining({ sourceId: s2.body.id, status: 'drafted', journalId: j!.body.id })]);
  });

  it('are never posted automatically: a different person posts, and the books reflect it', async () => {
    const { w, accountant } = await setup();
    lastAuth = w.org.auth;
    const s = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.fabric.variantId, quantity: '2' }], [cash(752608)]);
    await drain();
    const j = await journalFor('pos_sale', s.body.id);
    expect(j!.body.status).toBe('draft');
    expect((await trialBalance(ctx.app, { ng: w.ng } as any, '2999-12-31', w.org.auth)).body.totals.debitMinor).toBe(0);   // drafts do not count

    const cashierPosts = await cmd(ctx.app, (await staff(ctx.app, w.org.auth, ['accounting.post'], { type: 'legal_entity', id: w.ng })).auth, `/v1/accounting/journals/${j!.body.id}/post`, {});
    expect(cashierPosts.status).toBe(200);                                                                    // anyone other than the cashier may post
    const tb = await trialBalance(ctx.app, { ng: w.ng } as any, '2999-12-31', accountant.auth);
    expect(tb.body.totals).toMatchObject({ debitMinor: 752608, creditMinor: 752608, balanced: true });
    expect(tb.body.accountingEquation.holds).toBe(true);
    expect(tb.body.accounts.map((a: any) => [a.code, a.debitMinor, a.creditMinor])).toEqual([['1010', 752608, 0], ['2200', 0, 52508], ['4000', 0, 700100]]);
  });

  it('wait for payment verification, then draft once with every payment method', async () => {
    const { w } = await setup();
    lastAuth = w.org.auth;
    const s = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.fabric.variantId, quantity: '1' }], [cash(76304), card(300000)]);
    await drain();
    expect(await journalFor('pos_sale', s.body.id)).toBeNull();                                               // still pending payment
    expect((await call(ctx.app, 'GET', `/v1/accounting/posting-log?legalEntityId=${w.ng}`, w.org.auth)).body).toEqual([]);   // and not reported as a problem
    const cardId = s.body.payments.find((p: any) => p.method === 'card').id;
    await cmd(ctx.app, w.supervisor.auth, `/v1/pos/payments/${cardId}/verify`, {});
    await drain();
    const j = await journalFor('pos_sale', s.body.id);
    expect(lines(j)).toEqual([['1020', 300000, 0], ['1010', 76304, 0], ['4000', 0, 350050], ['2200', 0, 26254]]);   // payment lines are ordered by method

    // A failed payment never produces a journal.
    const bad = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.fabric.variantId, quantity: '1' }], [card(376304)]);
    await cmd(ctx.app, w.supervisor.auth, `/v1/pos/payments/${bad.body.payments[0].id}/fail`, {});
    await drain();
    expect(await journalFor('pos_sale', bad.body.id)).toBeNull();
  });

  it('never create a second journal when events are replayed', async () => {
    const { w } = await setup();
    lastAuth = w.org.auth;
    const s = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.fabric.variantId, quantity: '1' }], [cash(376304)]);
    await drain();
    await ctx.db.query(`UPDATE event_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE target_key = 'pos-revenue-posting' AND event_id IN (SELECT id FROM domain_events WHERE organization_id = $1)`, [w.org.organizationId]);
    await Promise.all([drain(dispatcher()), drain(dispatcher())]);
    const rows = await ctx.db.query('SELECT 1 FROM journal_entries WHERE source_type = $1 AND source_id = $2', ['pos_sale', s.body.id]);
    expect(rows.rowCount).toBe(1);
  });

  it('handle discounts and tax-inclusive prices, with revenue net of tax', async () => {
    const { w } = await setup();
    lastAuth = w.org.auth;
    const s = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.inclusive.variantId, quantity: '3', discount: { type: 'amount', amountMinor: 1 } }], [cash(10001)]);
    await drain();
    const j = await journalFor('pos_sale', s.body.id);
    expect(lines(j)).toEqual([['1010', 10001, 0], ['4000', 0, 9303], ['2200', 0, 698]]);                         // 10001 - 698 tax
  });

  it('balance to the cent against the sale for a spread of quantities, discounts and tax types', async () => {
    const { w } = await setup();
    lastAuth = w.org.auth;
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 14; i++) {
      const fabric = rnd(2) === 0;
      const qty = ['0.25', '1', '2.5', '3.33', '7', '12.75'][rnd(6)]!;
      const bps = [0, 100, 333, 500, 999][rnd(5)]!;
      const priced = priceLine(fabric
        ? { quantity: qty, unitPrice: '3500.5', minorUnit: 2, discount: bps ? { type: 'percent', basisPoints: bps } : undefined, tax: { code: 'V', rate: '0.075', inclusive: false } }
        : { quantity: String(Math.ceil(Number(qty))), unitPrice: '33.34', minorUnit: 2, discount: bps ? { type: 'percent', basisPoints: bps } : undefined, tax: { code: 'V', rate: '0.075', inclusive: true } });
      const line = fabric ? { variantId: w.fabric.variantId, quantity: qty } : { variantId: w.inclusive.variantId, quantity: String(Math.ceil(Number(qty))) };
      const s = await sell(ctx.app, w.cashier.auth, w.reg1, [bps ? { ...line, discount: { type: 'percent', basisPoints: bps } } : line], [cash(Number(priced.total))]);
      expect(s.status).toBe(201);
      await drain();
      const j = await journalFor('pos_sale', s.body.id);
      const d = j!.body.lines.reduce((a: number, l: any) => a + l.debitMinor, 0);
      const c = j!.body.lines.reduce((a: number, l: any) => a + l.creditMinor, 0);
      expect(d).toBe(c);
      expect(d).toBe(s.body.totalMinor);
      expect(j!.body.lines.find((l: any) => l.accountCode === '2200').creditMinor).toBe(s.body.taxMinor);
    }
  });
});

describe('switching rules off', () => {
  it('stops drafting immediately, keeps the mapping, and resumes when re-enabled', async () => {
    const { w, acc } = await setup();
    lastAuth = w.org.auth;
    const accounts = { cash: acc.cash, card: acc.card, salesRevenue: acc.revenue, salesTaxPayable: acc.tax };
    await rules(w, { enabled: false, accounts });
    expect((await call(ctx.app, 'GET', `/v1/accounting/posting-rules/${w.ng}/pos`, w.org.auth)).body).toMatchObject({ enabled: false, accounts });
    const off = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.fabric.variantId, quantity: '1' }], [cash(376304)]);
    await drain();
    expect(await journalFor('pos_sale', off.body.id)).toBeNull();
    expect((await call(ctx.app, 'GET', `/v1/accounting/posting-log?legalEntityId=${w.ng}`, w.org.auth)).body).toEqual([]);
    await rules(w, { enabled: true, accounts });
    const on = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.fabric.variantId, quantity: '1' }], [cash(376304)]);
    await drain();
    expect(await journalFor('pos_sale', on.body.id)).not.toBeNull();
    expect(await journalFor('pos_sale', off.body.id)).toBeNull();                                            // earlier sales wait for an explicit backfill
  });
});

describe('returns', () => {
  it('draft the mirror journal with the tax portion split out', async () => {
    const { w } = await setup();
    lastAuth = w.org.auth;
    const s = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.inclusive.variantId, quantity: '3', discount: { type: 'amount', amountMinor: 1 } }], [cash(10001)]);
    const r = await cmd(ctx.app, w.cashier.auth, `/v1/pos/sales/${s.body.id}/returns`, { reason: 'Customer changed mind', refund: { method: 'cash' }, lines: [{ saleLineId: s.body.lines[0].id, quantity: '1', restock: true }] });
    expect(r.status).toBe(201);
    await drain();
    const j = await journalFor('pos_return', r.body.id);
    expect(j!.body).toMatchObject({ sourceType: 'pos_return', status: 'draft', createdBy: w.cashier.userId });
    expect(j!.body.description).toContain(r.body.returnNumber);
    expect(lines(j)).toEqual([['4000', 3101, 0], ['2200', 233, 0], ['1010', 0, 3334]]);       // 3334 refund = 3101 revenue + 233 tax
  });
});

describe('problems are visible and recoverable', () => {
  it('skips with a reason when a payment method has no account, then recovers after the mapping is fixed', async () => {
    const { w, acc } = await setup();
    lastAuth = w.org.auth;
    await rules(w, { enabled: true, accounts: { cash: acc.cash, salesRevenue: acc.revenue, salesTaxPayable: acc.tax } });   // card not mapped
    const s = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.fabric.variantId, quantity: '1' }], [card(376304)]);
    await cmd(ctx.app, w.supervisor.auth, `/v1/pos/payments/${s.body.payments[0].id}/verify`, {});
    await drain();
    expect(await journalFor('pos_sale', s.body.id)).toBeNull();
    const log = await call(ctx.app, 'GET', `/v1/accounting/posting-log?legalEntityId=${w.ng}&status=skipped`, w.org.auth);
    expect(log.body).toEqual([expect.objectContaining({ sourceType: 'pos_sale', sourceId: s.body.id, status: 'skipped', reason: 'No clearing account is mapped for card payments' })]);
    const dead = await ctx.db.query(`SELECT 1 FROM event_deliveries WHERE target_key = 'pos-revenue-posting' AND status = 'dead' AND organization_id = $1`, [w.org.organizationId]);
    expect(dead.rowCount).toBe(0);                                                                           // a config problem does not retry forever

    await rules(w, { enabled: true, accounts: { cash: acc.cash, card: acc.card, salesRevenue: acc.revenue, salesTaxPayable: acc.tax } });
    const retry = await call(ctx.app, 'POST', `/v1/accounting/posting-log/pos_sale/${s.body.id}/retry`, w.org.auth);
    expect(retry.body.status).toBe('drafted');
    expect(lines(await journalFor('pos_sale', s.body.id))).toEqual([['1020', 376304, 0], ['4000', 0, 350050], ['2200', 0, 26254]]);
    expect((await call(ctx.app, 'GET', `/v1/accounting/posting-log?legalEntityId=${w.ng}&status=skipped`, w.org.auth)).body).toEqual([]);
  });

  it('skips when the sale has tax but no tax account is mapped, and when an account was archived', async () => {
    const { w, acc } = await setup();
    lastAuth = w.org.auth;
    await rules(w, { enabled: true, accounts: { cash: acc.cash, salesRevenue: acc.revenue } });
    const s = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.fabric.variantId, quantity: '1' }], [cash(376304)]);
    await drain();
    const skipped = async () => (await call(ctx.app, 'GET', `/v1/accounting/posting-log?legalEntityId=${w.ng}&status=skipped`, w.org.auth)).body;
    expect((await skipped())[0].reason).toMatch(/no sales tax payable account/);

    await rules(w, { enabled: true, accounts: { cash: acc.cash, salesRevenue: acc.revenue, salesTaxPayable: acc.tax } });
    await call(ctx.app, 'POST', `/v1/accounting/accounts/${acc.revenue}/archive`, w.org.auth);
    const retry = await call(ctx.app, 'POST', `/v1/accounting/posting-log/pos_sale/${s.body.id}/retry`, w.org.auth);
    expect(retry.body).toMatchObject({ status: 'skipped' });
    expect(retry.body.reason).toMatch(/archived/);
  });

  it('backfills sales made before the rules were switched on, once', async () => {
    const { w, acc } = await setup(false);
    lastAuth = w.org.auth;
    const sold = [];
    for (let i = 0; i < 3; i++) sold.push((await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.fabric.variantId, quantity: '1' }], [cash(376304)])).body.id);
    await drain();
    await rules(w, { enabled: true, accounts: { cash: acc.cash, salesRevenue: acc.revenue, salesTaxPayable: acc.tax } });
    const today = new Date().toISOString().slice(0, 10);
    const range = { from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), to: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) };
    void today;
    const first = await call(ctx.app, 'POST', `/v1/accounting/posting-rules/${w.ng}/backfill`, w.org.auth, range);
    expect(first.body).toMatchObject({ considered: 3, drafted: 3, skipped: 0 });
    for (const id of sold) expect(await journalFor('pos_sale', id)).not.toBeNull();
    expect((await call(ctx.app, 'POST', `/v1/accounting/posting-rules/${w.ng}/backfill`, w.org.auth, range)).body).toMatchObject({ considered: 0, drafted: 0 });
    expect((await call(ctx.app, 'POST', `/v1/accounting/posting-rules/${w.ng}/backfill`, w.cashier.auth, range)).status).toBe(403);
  });
});

describe('isolation', () => {
  it('keeps log and rules within the organization', async () => {
    const a = await setup();
    const b = await setup();
    lastAuth = a.w.org.auth;
    const s = await sell(ctx.app, a.w.cashier.auth, a.w.reg1, [{ variantId: a.w.fabric.variantId, quantity: '1' }], [card(376304)]);
    await rules(a.w, { enabled: true, accounts: { cash: a.acc.cash, salesRevenue: a.acc.revenue } });
    await cmd(ctx.app, a.w.supervisor.auth, `/v1/pos/payments/${s.body.payments[0].id}/verify`, {});
    await drain();
    expect((await call(ctx.app, 'GET', `/v1/accounting/posting-log?legalEntityId=${a.w.ng}`, b.w.org.auth)).status).toBe(404);
    expect((await call(ctx.app, 'POST', `/v1/accounting/posting-log/pos_sale/${s.body.id}/retry`, b.w.org.auth)).status).toBe(404);
    expect((await call(ctx.app, 'PUT', `/v1/accounting/posting-rules/${a.w.ng}/pos`, b.w.org.auth, { enabled: false })).status).toBe(404);
  });
});
