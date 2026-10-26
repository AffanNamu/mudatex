import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newOrg, setupApp, staff } from './helpers.js';
import { balance, buildWorld, cmd } from './inventory-helpers.js';
import { buildPosWorld, openSession, SUPERVISOR_PERMS, type PosWorld } from './pos-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

async function till(stock = '100') {
  const w = await buildPosWorld(ctx.app, await buildWorld(ctx.app, await newOrg(ctx.db)), stock);
  const sessionId = await openSession(ctx.app, w.cashier.auth, w.reg1);
  let n = 0;
  const sale = (over: Record<string, unknown> = {}) => ({
    clientSaleId: crypto.randomUUID(), registerId: w.reg1, sessionId, soldAt: new Date().toISOString(), deviceId: 'tab-1', localReceiptNo: `OFF-T1-${++n}`,
    lines: [{ variantId: w.fabric.variantId, quantity: '2' }], tillTotalMinor: 750108, tenderedMinor: 800000, ...over,
  });
  const send = (sales: unknown[], auth = w.cashier.auth) => call(ctx.app, 'POST', '/v1/pos/offline-sales', auth, { sales });
  const fabric = () => balance(ctx.app, w.org.auth, { locationId: w.shop, variantId: w.fabric.variantId });
  return { w, sessionId, sale, send, fabric };
}
// 2 m x 3,500.50 = 7,001.00 + 7.5% VAT 525.08 (rounded) = 7,526.08
const TOTAL = 752608;

describe('the offline pack', () => {
  it('carries prices, tax, barcodes and the stock list for ordinary products, only for the cashier who opened the session', async () => {
    const t = await till();
    const pack = await call(ctx.app, 'GET', `/v1/pos/registers/${t.w.reg1}/offline-pack`, t.w.cashier.auth);
    expect(pack.status).toBe(200);
    expect(pack.body).toMatchObject({ currency: 'NGN', minorUnit: 2, session: { id: t.sessionId }, rules: { maxDiscountBps: 1000, mayDiscount: true, mayOverride: false }, validHours: 24 });
    const fabric = pack.body.items.find((i: any) => i.variantId === t.w.fabric.variantId);
    expect(fabric).toMatchObject({ unitPrice: '3500.5000', taxRate: '0.075000', taxInclusive: false, available: '100.000000', unit: 'm' });
    // rolls and lots are never offered offline
    expect(pack.body.items.some((i: any) => i.variantId === t.w.rolled.variantId || i.variantId === t.w.lotted.variantId)).toBe(false);
    const again = await call(ctx.app, 'GET', `/v1/pos/registers/${t.w.reg1}/offline-pack`, t.w.cashier.auth);
    expect(again.body.version).toBe(pack.body.version);
    // another person gets no session, so cannot use this drawer
    const other = await call(ctx.app, 'GET', `/v1/pos/registers/${t.w.reg1}/offline-pack`, t.w.supervisor.auth);
    expect(other.body.session).toBeNull();
    const nobody = await staff(ctx.app, t.w.org.auth, ['catalog.read'], { type: 'group' });
    expect((await call(ctx.app, 'GET', `/v1/pos/registers/${t.w.reg1}/offline-pack`, nobody.auth)).status).toBe(403);
  });
});

describe('sending offline sales', () => {
  it('records each as a completed cash sale priced by the server, takes stock off the shelf and numbers receipts in selling order', async () => {
    const t = await till();
    const later = t.sale({ soldAt: new Date(Date.now() - 1000).toISOString() });
    const earlier = t.sale({ soldAt: new Date(Date.now() - 5000).toISOString(), lines: [{ variantId: t.w.fabric.variantId, quantity: '1' }], tillTotalMinor: 376304 });
    const res = await t.send([later, earlier]);
    expect(res.status).toBe(200);
    // sent out of order, numbered in the order they were sold
    expect(res.body.results.map((r: any) => [r.clientSaleId === earlier.clientSaleId ? 'earlier' : 'later', r.status, r.receiptNumber, r.totalMinor, r.varianceMinor])).toEqual([
      ['earlier', 'created', 'SHOP1-000001', 376304, 0], ['later', 'created', 'SHOP1-000002', TOTAL, 750108 - TOTAL],
    ]);
    expect(await t.fabric()).toMatchObject({ quantity: '97', reserved: '0' });
    const sale = await call(ctx.app, 'GET', `/v1/pos/sales/${res.body.results[1].saleId}`, t.w.org.auth);
    expect(sale.body).toMatchObject({ status: 'completed', totalMinor: TOTAL, payments: [expect.objectContaining({ method: 'cash', status: 'confirmed', amountMinor: TOTAL, tenderedMinor: 800000 })] });
    const { rows } = await ctx.db.query('SELECT offline, offline_receipt_no, offline_variance_minor, device_id FROM pos_sales WHERE id = $1', [res.body.results[1].saleId]);
    expect(rows[0]).toMatchObject({ offline: true, offline_receipt_no: later.localReceiptNo, offline_variance_minor: '-2500', device_id: 'tab-1' });
  });

  it('creates a sale only once however often it is sent, even all at once', async () => {
    const t = await till();
    const s = t.sale();
    expect((await t.send([s])).body.results[0].status).toBe('created');
    const again = await t.send([s]);
    expect(again.body.results[0]).toMatchObject({ status: 'duplicate', receiptNumber: 'SHOP1-000001', totalMinor: TOTAL });
    const s2 = t.sale();
    const both = await Promise.all([t.send([s2]), t.send([s2])]);
    expect(both.map((b) => b.body.results[0].status).sort()).toEqual(['created', 'duplicate']);
    expect((await t.fabric()).quantity).toBe('96'); // two sales of 2 m, not four
  });

  it('prices at the moment of the sale, not at the moment it arrives', async () => {
    const t = await till();
    await new Promise((r) => setTimeout(r, 1200));
    const before = new Date(Date.now() - 600).toISOString();
    // the price goes up now; a sale made just before it still gets the old price
    await call(ctx.app, 'PUT', `/v1/pricing/price-lists/${t.w.priceList}/items`, t.w.org.auth, { variantId: t.w.fabric.variantId, unitPrice: '4000', taxCodeId: t.w.vat });
    const old = await t.send([t.sale({ soldAt: before })]);
    expect(old.body.results[0].totalMinor).toBe(TOTAL);
    const fresh = await t.send([t.sale({ soldAt: new Date().toISOString(), tillTotalMinor: TOTAL })]);
    expect(fresh.body.results[0]).toMatchObject({ totalMinor: 860000, varianceMinor: TOTAL - 860000 }); // 2 x 4,000 + 7.5%
  });

  it('never trusts the till\'s clock: a sale from the future or from before the session is placed inside the session', async () => {
    const t = await till();
    const future = await t.send([t.sale({ soldAt: new Date(Date.now() + 86_400_000).toISOString() })]);
    const past = await t.send([t.sale({ soldAt: '2001-01-01T00:00:00.000Z' })]);
    expect(future.body.results[0].status).toBe('created');
    expect(past.body.results[0].status).toBe('created');
    const { rows } = await ctx.db.query('SELECT sold_at, client_timestamp FROM pos_sales WHERE session_id = $1 ORDER BY created_at', [t.sessionId]);
    for (const r of rows) {
      expect(new Date(r.sold_at).getTime()).toBeLessThanOrEqual(Date.now());
      expect(new Date(r.sold_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    }
    expect(new Date(rows[1].client_timestamp).getFullYear()).toBe(2001); // what the till claimed is kept as it was
  });

  it('records a shortage as an exception instead of going below zero, and the stock controller clears it', async () => {
    const t = await till('10');
    const res = await t.send([t.sale({ lines: [{ variantId: t.w.fabric.variantId, quantity: '14' }], tillTotalMinor: 5268256 })]);
    expect(res.body.results[0]).toMatchObject({ status: 'created', shortages: 1 });
    expect(await t.fabric()).toMatchObject({ quantity: '0' });
    const ex = await call(ctx.app, 'GET', '/v1/pos/offline-exceptions', t.w.org.auth);
    expect(ex.body).toEqual([expect.objectContaining({ quantityShort: '4', sku: expect.any(String), receiptNumber: 'SHOP1-000001', offlineReceiptNo: 'OFF-T1-1' })]);
    const nobody = await staff(ctx.app, t.w.org.auth, ['catalog.read'], { type: 'group' });
    expect((await call(ctx.app, 'GET', '/v1/pos/offline-exceptions', nobody.auth)).body).toEqual([]);
    expect((await call(ctx.app, 'POST', `/v1/pos/offline-exceptions/${ex.body[0].id}/resolve`, nobody.auth, { note: 'No permission here' })).status).toBe(403);
    expect((await call(ctx.app, 'POST', `/v1/pos/offline-exceptions/${ex.body[0].id}/resolve`, t.w.org.auth, { note: 'Late receipt of 4 m posted' })).body.status).toBe('resolved');
    expect((await call(ctx.app, 'GET', '/v1/pos/offline-exceptions', t.w.org.auth)).body).toEqual([]);
    expect((await call(ctx.app, 'GET', '/v1/pos/offline-exceptions?status=resolved', t.w.org.auth)).body).toHaveLength(1);
  });

  it('turns away what it cannot accept, with a reason, without losing the rest of the batch', async () => {
    const t = await till();
    const good = t.sale();
    const roll = t.sale({ lines: [{ variantId: t.w.rolled.variantId, quantity: '1' }] });
    const stranger = t.sale({ sessionId: crypto.randomUUID() });
    const bigDiscount = t.sale({ lines: [{ variantId: t.w.fabric.variantId, quantity: '1', discount: { type: 'percent', basisPoints: 5000 } }] });
    const res = await t.send([good, roll, stranger, bigDiscount]);
    const by = Object.fromEntries(res.body.results.map((r: any) => [r.clientSaleId, r]));
    expect(by[good.clientSaleId].status).toBe('created');
    expect(by[roll.clientSaleId]).toMatchObject({ status: 'rejected', reason: 'Rolls and lots cannot be sold offline' });
    expect(by[stranger.clientSaleId]).toMatchObject({ status: 'rejected', reason: 'Unknown session' });
    expect(by[bigDiscount.clientSaleId]).toMatchObject({ status: 'rejected' });
    expect(by[bigDiscount.clientSaleId].reason).toMatch(/limit/);
    expect(await t.fabric()).toMatchObject({ quantity: '98' });
  });

  it('refuses sales for a closed session, another cashier\'s session, and people who may not sell', async () => {
    const t = await till();
    const s = t.sale();
    expect((await t.send([s], t.w.supervisor.auth)).body.results[0]).toMatchObject({ status: 'rejected', reason: 'This session belongs to another cashier' });
    const nobody = await staff(ctx.app, t.w.org.auth, ['catalog.read'], { type: 'group' });
    expect((await t.send([s], nobody.auth)).body.results[0]).toMatchObject({ status: 'rejected', reason: 'You may not sell at this register' });
    const close = await cmd(ctx.app, t.w.cashier.auth, `/v1/pos/sessions/${t.sessionId}/close`, { countedCashMinor: 0 });
    expect(close.status).toBe(200);
    expect((await t.send([s])).body.results[0]).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/closed/) });
  });

  it('keeps the drawer honest: the cash expected at closing includes offline sales', async () => {
    const t = await till();
    await t.send([t.sale()]);
    const report = await call(ctx.app, 'GET', `/v1/pos/sessions/${t.sessionId}/report`, t.w.cashier.auth);
    expect(report.body).toMatchObject({ expectedCashMinor: TOTAL, salesByMethod: [expect.objectContaining({ method: 'cash', totalMinor: TOTAL })] });
  });
});
