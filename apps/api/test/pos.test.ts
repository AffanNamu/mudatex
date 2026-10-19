import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newOrg, setupApp, staff } from './helpers.js';
import { balance, buildWorld, cmd, reconciled } from './inventory-helpers.js';
import { buildPosWorld, card, cash, openSession, sell, SUPERVISOR_PERMS, type PosWorld } from './pos-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

const pos = async (stock = '100') => buildPosWorld(ctx.app, await buildWorld(ctx.app, await newOrg(ctx.db)), stock);
const fabricStock = (w: PosWorld) => balance(ctx.app, w.org.auth, { locationId: w.shop, variantId: w.fabric.variantId });
const line = (w: PosWorld, quantity: string, extra: Record<string, unknown> = {}) => ({ variantId: w.fabric.variantId, quantity, ...extra });

describe('pricing', () => {
  it('versions prices by effective date without overlaps and keeps tax codes immutable', async () => {
    const w = await pos();
    const a = w.org.auth;
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const next = await call(ctx.app, 'PUT', `/v1/pricing/price-lists/${w.priceList}/items`, a, { variantId: w.fabric.variantId, unitPrice: '4000', taxCodeId: w.vat, effectiveFrom: future });
    expect(next.status).toBe(201);
    const items = await call(ctx.app, 'GET', `/v1/pricing/price-lists/${w.priceList}/items`, a);
    const fabric = items.body.filter((i: any) => i.variantId === w.fabric.variantId);
    expect(fabric).toHaveLength(2);
    expect(fabric[0]).toMatchObject({ unitPrice: '3500.5', effectiveTo: future });
    expect(fabric[1]).toMatchObject({ unitPrice: '4000', effectiveTo: null });
    // A price starting before the latest one cannot be inserted.
    const earlier = await call(ctx.app, 'PUT', `/v1/pricing/price-lists/${w.priceList}/items`, a, { variantId: w.fabric.variantId, unitPrice: '1', effectiveFrom: new Date(Date.now() + 1000).toISOString() });
    expect(earlier.status).toBe(409);
    const nowPrice = await call(ctx.app, 'GET', `/v1/pricing/price-lists/${w.priceList}/items?at=${new Date().toISOString()}`, a);
    expect(nowPrice.body.find((i: any) => i.variantId === w.fabric.variantId).unitPrice).toBe('3500.5');
    await expect(ctx.db.query("UPDATE tax_codes SET rate = 0.5 WHERE id = $1", [w.vat])).rejects.toThrow(/immutable/);
  });

  it('refuses a tax code from another legal entity and enforces scope', async () => {
    const w = await pos();
    const ghTax = await call(ctx.app, 'POST', '/v1/pricing/tax-codes', w.org.auth, { legalEntityId: w.gh, code: 'GHVAT', name: 'GH VAT', rate: '0.15', priceInclusive: false });
    const bad = await call(ctx.app, 'PUT', `/v1/pricing/price-lists/${w.priceList}/items`, w.org.auth, { variantId: w.fabric.variantId, unitPrice: '5', taxCodeId: ghTax.body.id });
    expect(bad.status).toBe(422);
    const cashier = await call(ctx.app, 'PUT', `/v1/pricing/price-lists/${w.priceList}/items`, w.cashier.auth, { variantId: w.fabric.variantId, unitPrice: '1' });
    expect(cashier.status).toBe(403);
    expect((await call(ctx.app, 'POST', '/v1/pricing/price-lists', w.org.auth, { legalEntityId: w.ng, name: 'Bad', currency: 'XXX' })).status).toBe(422);
  });
});

describe('sessions', () => {
  it('allows one open session per register and requires one to sell', async () => {
    const w = await pos();
    const noSession = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1')], [cash(350050 + 26254)]);
    expect(noSession.status).toBe(409);
    await openSession(ctx.app, w.cashier.auth, w.reg1, 5000);
    expect((await cmd(ctx.app, w.supervisor.auth, `/v1/pos/registers/${w.reg1}/sessions`, { openingFloatMinor: 0 })).status).toBe(409);
    // Another cashier cannot sell on a session they did not open.
    const other = await sell(ctx.app, w.supervisor.auth, w.reg1, [line(w, '1')], [cash(376304)]);
    expect(other.status).toBe(403);
  });

  it('restricts sessions to the register location', async () => {
    const w = await pos();
    const elsewhere = await staff(ctx.app, w.org.auth, ['pos.sell', 'pos.session'], { type: 'location', id: w.w1 });
    expect((await cmd(ctx.app, elsewhere.auth, `/v1/pos/registers/${w.reg1}/sessions`, { openingFloatMinor: 0 })).status).toBe(403);
  });
});

describe('cash sales', () => {
  it('prices, taxes, issues stock and numbers receipts without gaps', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    // 7.5 m x 3,500.50 = 26,253.75; VAT 7.5% = 1,969.03 (half-up); total 28,222.78
    const s1 = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '7.5')], [cash(2822278, 2830000)], { expectedTotalMinor: 2822278 });
    expect(s1.status).toBe(201);
    expect(s1.body).toMatchObject({ receiptNumber: 'SHOP1-000001', status: 'completed', currency: 'NGN', subtotalMinor: 2625375, taxMinor: 196903, discountMinor: 0, totalMinor: 2822278 });
    expect(s1.body.lines[0]).toMatchObject({ unitPrice: '3500.5', taxCode: 'VAT75', taxRate: '0.075', quantity: '7.5', totalMinor: 2822278 });
    expect(s1.body.payments[0]).toMatchObject({ method: 'cash', amountMinor: 2822278, tenderedMinor: 2830000, changeMinor: 7722, status: 'confirmed' });
    expect((await fabricStock(w)).quantity).toBe('92.5');

    // A failed sale rolls back and does not burn a receipt number.
    const tooMuch = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1000')], [cash(1)]);
    expect([409, 422]).toContain(tooMuch.status);
    const big = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '99')], [cash(37252305 + 2)]);
    expect(big.status).toBe(422); // wrong payment total
    const s2 = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1')], [cash(376304)]);
    expect(s2.body.receiptNumber).toBe('SHOP1-000002');
    expect((await reconciled(ctx.app, w.org.auth)).consistent).toBe(true);
  });

  it('extracts tax from inclusive prices and rounds each line', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const s = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.inclusive.variantId, quantity: '3' }], [cash(10002)]);
    expect(s.body).toMatchObject({ totalMinor: 10002, subtotalMinor: 10002 });
    expect(s.body.lines[0]).toMatchObject({ taxInclusive: true, totalMinor: 10002 });
    // 100.02 x 0.075 / 1.075 = 6.978 -> 698 minor, already contained in the price
    expect(s.body.taxMinor).toBe(698);
    expect(s.body.lines[0].taxMinor).toBe(698);
  });

  it('rejects payment mismatches, price drift, missing prices and bad cash', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const L = [line(w, '1')]; // total 376304
    expect((await sell(ctx.app, w.cashier.auth, w.reg1, L, [cash(376303)])).status).toBe(422);
    expect((await sell(ctx.app, w.cashier.auth, w.reg1, L, [cash(376305)])).status).toBe(422);
    expect((await sell(ctx.app, w.cashier.auth, w.reg1, L, [cash(376304, 376000)])).status).toBe(422);
    expect((await sell(ctx.app, w.cashier.auth, w.reg1, L, [cash(376304)], { expectedTotalMinor: 376303 })).status).toBe(409);
    // A variant with no price on the register's list cannot be sold.
    const unpriced = await call(ctx.app, 'POST', '/v1/products', w.org.auth, { name: 'NoPrice', baseUnitId: w.m, variants: [{ sku: 'NP-1' }] });
    const np = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: unpriced.body.variantIds[0], quantity: '1' }], [cash(100)]);
    expect(np.status).toBe(422);
    expect((await fabricStock(w)).quantity).toBe('100');
  });

  it('snapshots price and tax on the receipt', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const s = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '2')], [cash(752608)]);
    await call(ctx.app, 'PUT', `/v1/pricing/price-lists/${w.priceList}/items`, w.org.auth, { variantId: w.fabric.variantId, unitPrice: '9999', taxCodeId: null });
    const again = await call(ctx.app, 'GET', `/v1/pos/sales/${s.body.id}`, w.cashier.auth);
    expect(again.body.lines[0]).toMatchObject({ unitPrice: '3500.5', taxRate: '0.075' });
    expect(again.body.totalMinor).toBe(s.body.totalMinor);
  });

  it('handles zero-decimal currencies', async () => {
    const w = await pos();
    const xof = await call(ctx.app, 'POST', '/v1/legal-entities', w.org.auth, { name: 'Mudatex CI', countryCode: 'CI', functionalCurrency: 'XOF' });
    const loc = await call(ctx.app, 'POST', '/v1/locations', w.org.auth, { legalEntityId: xof.body.id, type: 'branch', name: 'Abidjan', countryCode: 'CI', timezone: 'Africa/Abidjan' });
    const pl = await call(ctx.app, 'POST', '/v1/pricing/price-lists', w.org.auth, { legalEntityId: xof.body.id, name: 'Retail XOF', currency: 'XOF' });
    await call(ctx.app, 'PUT', `/v1/pricing/price-lists/${pl.body.id}/items`, w.org.auth, { variantId: w.fabric.variantId, unitPrice: '1500' });
    const reg = await call(ctx.app, 'POST', '/v1/pos/registers', w.org.auth, { locationId: loc.body.id, code: 'CI1', name: 'CI', priceListId: pl.body.id });
    await cmd(ctx.app, w.org.auth, '/v1/inventory/receipts', { locationId: loc.body.id, lines: [{ variantId: w.fabric.variantId, quantity: '10' }] });
    const session = await openSession(ctx.app, w.org.auth, reg.body.id);
    expect(session).toBeTruthy();
    const s = await sell(ctx.app, w.org.auth, reg.body.id, [line(w, '2.5')], [cash(3750)]);
    expect(s.body).toMatchObject({ currency: 'XOF', minorUnit: 0, totalMinor: 3750 });
  });
});

describe('discounts', () => {
  it('enforces the register limit and the discount permission', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    await openSession(ctx.app, w.supervisor.auth, w.reg2);
    // 5%: gross 350050, discount 17503 (half-up of 17502.5), net 332547, tax 24941, total 357488
    const ok = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1', { discount: { type: 'percent', basisPoints: 500 } })], [cash(357488)]);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ discountMinor: 17503, taxMinor: 24941, totalMinor: 357488 });

    const tooBig = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1', { discount: { type: 'percent', basisPoints: 2000 } })], [cash(1)]);
    expect(tooBig.status).toBe(403);
    const amount = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1', { discount: { type: 'amount', amountMinor: 100000 } })], [cash(1)]);
    expect(amount.status).toBe(403);
    // A user with the override permission may exceed it.
    const over = await sell(ctx.app, w.supervisor.auth, w.reg2, [line(w, '1', { discount: { type: 'percent', basisPoints: 2000 } })], [cash(301043)]);
    expect(over.status).toBe(201);
    expect(over.body.discountMinor).toBe(70010);

    const noDiscountRole = await staff(ctx.app, w.org.auth, ['pos.sell', 'pos.session'], { type: 'location', id: w.shop });
    const reg3 = await call(ctx.app, 'POST', '/v1/pos/registers', w.org.auth, { locationId: w.shop, code: 'SHOP3', name: 'S3', priceListId: w.priceList });
    await openSession(ctx.app, noDiscountRole.auth, reg3.body.id);
    const denied = await sell(ctx.app, noDiscountRole.auth, reg3.body.id, [line(w, '1', { discount: { type: 'percent', basisPoints: 100 } })], [cash(1)]);
    expect(denied.status).toBe(403);
  });

  it('rejects a discount larger than the line', async () => {
    const w = await pos();
    await openSession(ctx.app, w.supervisor.auth, w.reg1);
    const r = await sell(ctx.app, w.supervisor.auth, w.reg1, [line(w, '1', { discount: { type: 'amount', amountMinor: 350051 } })], [cash(1)]);
    expect(r.status).toBe(422);
  });
});

describe('non-cash payments', () => {
  it('holds stock while a card payment is unverified, and completes on verification by someone else', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const s = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '10')], [card(3763038)]);
    expect(s.body.status).toBe('pending_payment');
    expect(s.body.payments[0].status).toBe('pending');
    expect(await fabricStock(w)).toMatchObject({ quantity: '100', reserved: '10', available: '90' });

    const report = await call(ctx.app, 'GET', `/v1/pos/sessions/${(await call(ctx.app, 'GET', `/v1/pos/sales/${s.body.id}`, w.cashier.auth)).body.sessionId}/report`, w.cashier.auth);
    expect(report.body.pendingSales).toBe(1);
    expect(report.body.salesByMethod).toEqual([]);

    const pid = s.body.payments[0].id;
    // The cashier has no verify permission; a holder who recorded it may not verify their own either.
    expect((await cmd(ctx.app, w.cashier.auth, `/v1/pos/payments/${pid}/verify`, {})).status).toBe(403);
    const done = await cmd(ctx.app, w.supervisor.auth, `/v1/pos/payments/${pid}/verify`, {});
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    expect(await fabricStock(w)).toMatchObject({ quantity: '90', reserved: '0' });
    expect((await cmd(ctx.app, w.supervisor.auth, `/v1/pos/payments/${pid}/verify`, {})).status).toBe(409);
    expect((await reconciled(ctx.app, w.org.auth)).consistent).toBe(true);
  });

  it('forbids verifying a payment you recorded yourself', async () => {
    const w = await pos();
    await openSession(ctx.app, w.supervisor.auth, w.reg1);
    const s = await sell(ctx.app, w.supervisor.auth, w.reg1, [line(w, '1')], [card(376304)]);
    expect((await cmd(ctx.app, w.supervisor.auth, `/v1/pos/payments/${s.body.payments[0].id}/verify`, {})).status).toBe(403);
  });

  it('releases stock and voids cash when a mixed payment fails', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const s = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1')], [cash(76304), card(300000)]);
    expect(s.body.status).toBe('pending_payment');
    expect(s.body.payments.map((p: any) => p.status).sort()).toEqual(['confirmed', 'pending']);
    const cardId = s.body.payments.find((p: any) => p.method === 'card').id;
    const failed = await cmd(ctx.app, w.supervisor.auth, `/v1/pos/payments/${cardId}/fail`, {});
    expect(failed.body.status).toBe('cancelled');
    expect(failed.body.payments.map((p: any) => p.status).sort()).toEqual(['failed', 'voided']);
    expect(await fabricStock(w)).toMatchObject({ quantity: '100', reserved: '0' });
    const rep = await call(ctx.app, 'GET', `/v1/pos/sessions/${failed.body.sessionId}/report`, w.cashier.auth);
    expect(rep.body.expectedCashMinor).toBe(0);
  });

  it('lets the cashier cancel an unpaid sale but not a completed one', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const pending = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '2')], [card(752608)]);
    expect((await cmd(ctx.app, w.cashier.auth, `/v1/pos/sales/${pending.body.id}/cancel`, {})).body.status).toBe('cancelled');
    expect((await fabricStock(w)).reserved).toBe('0');
    const done = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1')], [cash(376304)]);
    expect((await cmd(ctx.app, w.cashier.auth, `/v1/pos/sales/${done.body.id}/cancel`, {})).status).toBe(409);
  });

  it('requires a provider reference for non-cash payments', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const r = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1')], [{ method: 'card', amountMinor: 376304 }]);
    expect(r.status).toBe(422);
  });
});

describe('concurrency and replay', () => {
  it('never sells more than the stock across registers', async () => {
    const w = await pos('3');
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    await openSession(ctx.app, w.supervisor.auth, w.reg2);
    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 2
          ? sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1')], [cash(376304)])
          : sell(ctx.app, w.supervisor.auth, w.reg2, [line(w, '1')], [cash(376304)]),
      ),
    );
    expect(attempts.filter((r) => r.status === 201)).toHaveLength(3);
    expect(attempts.filter((r) => r.status === 409)).toHaveLength(9);
    expect((await fabricStock(w)).quantity).toBe('0');
    const receipts = attempts.filter((r) => r.status === 201).map((r) => r.body.receiptNumber);
    expect(new Set(receipts).size).toBe(3);
    expect((await reconciled(ctx.app, w.org.auth)).consistent).toBe(true);
  });

  it('records a replayed sale once and returns the same receipt', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const key = 'sale-replay-0001';
    const results = await Promise.all(Array.from({ length: 6 }, () => sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1')], [cash(376304)], {}, key)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results[0]!.body.receiptNumber).toBe('SHOP1-000001');
    expect((await fabricStock(w)).quantity).toBe('99');
    const list = await call(ctx.app, 'GET', '/v1/pos/sales', w.cashier.auth);
    expect(list.body).toHaveLength(1);
  });
});

describe('tracked stock', () => {
  it('sells a specific roll and refuses an untracked-style sale', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const rcpt = await cmd(ctx.app, w.org.auth, '/v1/inventory/receipts', { locationId: w.shop, lines: [{ variantId: w.rolled.variantId, quantity: '50', lotCode: 'POS-ROLL' }] });
    const lotId = rcpt.body.lines[0].lotId;
    expect((await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.rolled.variantId, quantity: '5' }], [cash(600000)])).status).toBe(422);
    const ok = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.rolled.variantId, lotId, quantity: '5' }], [cash(600000)]);
    expect(ok.status).toBe(201);
    expect(ok.body.lines[0]).toMatchObject({ lotId, taxCode: null, totalMinor: 600000 });
    expect((await balance(ctx.app, w.org.auth, { locationId: w.shop, variantId: w.rolled.variantId, lotId })).quantity).toBe('45');
  });
});

describe('returns', () => {
  async function saleOfThree(w: PosWorld) {
    // 3 x 33.34 inclusive = 100.02, minus 0.01 discount = 100.01 (10001 minor), not divisible by 3
    const s = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.inclusive.variantId, quantity: '3', discount: { type: 'amount', amountMinor: 1 } }], [cash(10001)]);
    expect(s.status).toBe(201);
    return s.body;
  }
  const ret = (w: PosWorld, auth: any, saleId: string, lines: unknown[], method = 'cash', reason = 'Customer changed mind') =>
    cmd(ctx.app, auth, `/v1/pos/sales/${saleId}/returns`, { reason, refund: { method }, lines });
  const incStock = (w: PosWorld) => balance(ctx.app, w.org.auth, { locationId: w.shop, variantId: w.inclusive.variantId });

  it('refunds partial returns so the shares add up exactly, and restocks', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const sale = await saleOfThree(w);
    const lineId = sale.lines[0].id;
    expect((await incStock(w)).quantity).toBe('97');

    const amounts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await ret(w, w.cashier.auth, sale.id, [{ saleLineId: lineId, quantity: '1', restock: true }]);
      expect(r.status).toBe(201);
      amounts.push(r.body.refundTotalMinor);
    }
    expect(amounts).toEqual([3334, 3333, 3334]);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(10001);
    expect((await incStock(w)).quantity).toBe('100');
    expect((await ret(w, w.cashier.auth, sale.id, [{ saleLineId: lineId, quantity: '0.01', restock: true }])).status).toBe(409);
    const view = await call(ctx.app, 'GET', `/v1/pos/sales/${sale.id}`, w.cashier.auth);
    expect(view.body.lines[0].returnedQuantity).toBe('3');
    expect(view.body.returns.map((r: any) => r.returnNumber)).toEqual(['R-SHOP1-000001', 'R-SHOP1-000002', 'R-SHOP1-000003']);
    expect((await reconciled(ctx.app, w.org.auth)).consistent).toBe(true);
  });

  it('does not restock when the goods are not resaleable', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const sale = await saleOfThree(w);
    await ret(w, w.cashier.auth, sale.id, [{ saleLineId: sale.lines[0].id, quantity: '2', restock: false }]);
    expect((await incStock(w)).quantity).toBe('97');
  });

  it('limits refunds to the original payment methods and completed sales', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const sale = await saleOfThree(w);
    const l = [{ saleLineId: sale.lines[0].id, quantity: '1', restock: true }];
    expect((await ret(w, w.cashier.auth, sale.id, l, 'card')).status).toBe(422);
    expect((await ret(w, w.cashier.auth, sale.id, l, 'cash', 'no')).status).toBe(400);
    const pending = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1')], [card(376304)]);
    expect((await ret(w, w.cashier.auth, pending.body.id, [{ saleLineId: pending.body.lines[0].id, quantity: '1', restock: true }], 'card')).status).toBe(409);
  });

  it('needs a supervisor for refunds above the register limit', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const big = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '2')], [cash(752608)]);
    const l = [{ saleLineId: big.body.lines[0].id, quantity: '1', restock: true }];
    expect((await ret(w, w.cashier.auth, big.body.id, l)).status).toBe(403);
    const ok = await ret(w, w.supervisor.auth, big.body.id, l);
    expect(ok.status).toBe(201);
    expect(ok.body.refundTotalMinor).toBe(376304);
    expect(ok.body.refundStatus).toBe('recorded');
  });

  it('keeps non-cash refunds pending until a second person disburses them', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const s = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.inclusive.variantId, quantity: '1' }], [card(3334)]);
    await cmd(ctx.app, w.supervisor.auth, `/v1/pos/payments/${s.body.payments[0].id}/verify`, {});
    const r = await ret(w, w.cashier.auth, s.body.id, [{ saleLineId: s.body.lines[0].id, quantity: '1', restock: true }], 'card');
    expect(r.body.refundStatus).toBe('pending_disbursement');
    expect((await cmd(ctx.app, w.cashier.auth, `/v1/pos/returns/${r.body.id}/disburse`, { reference: 'RF-1' })).status).toBe(403);
    const done = await cmd(ctx.app, w.supervisor.auth, `/v1/pos/returns/${r.body.id}/disburse`, { reference: 'RF-1' });
    expect(done.body).toMatchObject({ refundStatus: 'disbursed', refundReference: 'RF-1' });
    expect((await cmd(ctx.app, w.supervisor.auth, `/v1/pos/returns/${r.body.id}/disburse`, { reference: 'RF-2' })).status).toBe(409);
  });

  it('requires an open session on the register', async () => {
    const w = await pos();
    const session = await openSession(ctx.app, w.cashier.auth, w.reg1);
    const sale = await saleOfThree(w);
    await cmd(ctx.app, w.cashier.auth, `/v1/pos/sessions/${session}/close`, { countedCashMinor: 10001 });
    const r = await ret(w, w.cashier.auth, sale.id, [{ saleLineId: sale.lines[0].id, quantity: '1', restock: true }]);
    expect(r.status).toBe(409);
  });
});

describe('closing a session', () => {
  it('computes expected cash from float, cash sales and cash refunds, and records variance', async () => {
    const w = await pos();
    const session = await openSession(ctx.app, w.cashier.auth, w.reg1, 10000);
    await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1')], [cash(376304, 400000)]);        // +376304
    const cardSale = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1')], [card(376304)]);
    await cmd(ctx.app, w.supervisor.auth, `/v1/pos/payments/${cardSale.body.payments[0].id}/verify`, {});
    const sale = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.inclusive.variantId, quantity: '1' }], [cash(3334)]);
    await cmd(ctx.app, w.cashier.auth, `/v1/pos/sales/${sale.body.id}/returns`, { reason: 'Wrong colour', refund: { method: 'cash' }, lines: [{ saleLineId: sale.body.lines[0].id, quantity: '1', restock: true }] });

    const report = await call(ctx.app, 'GET', `/v1/pos/sessions/${session}/report`, w.cashier.auth);
    expect(report.body.expectedCashMinor).toBe(10000 + 376304 + 3334 - 3334);
    expect(report.body.salesByMethod).toEqual([{ method: 'card', totalMinor: 376304, sales: 1 }, { method: 'cash', totalMinor: 379638, sales: 2 }]);

    expect((await cmd(ctx.app, w.supervisor.auth, `/v1/pos/sessions/${session}/close`, { countedCashMinor: 1 })).status).toBe(403);
    const closed = await cmd(ctx.app, w.cashier.auth, `/v1/pos/sessions/${session}/close`, { countedCashMinor: 386000, note: 'short 304' });
    expect(closed.body).toMatchObject({ status: 'closed', expectedCashMinor: 386304, varianceMinor: -304 });
    expect((await cmd(ctx.app, w.cashier.auth, `/v1/pos/sessions/${session}/close`, { countedCashMinor: 1 })).status).toBe(409);
    expect((await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1')], [cash(376304)])).status).toBe(409);
  });

  it('cannot close while a sale awaits payment', async () => {
    const w = await pos();
    const session = await openSession(ctx.app, w.cashier.auth, w.reg1);
    const pending = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1')], [card(376304)]);
    expect((await cmd(ctx.app, w.cashier.auth, `/v1/pos/sessions/${session}/close`, { countedCashMinor: 0 })).status).toBe(409);
    await cmd(ctx.app, w.cashier.auth, `/v1/pos/sales/${pending.body.id}/cancel`, {});
    expect((await cmd(ctx.app, w.cashier.auth, `/v1/pos/sessions/${session}/close`, { countedCashMinor: 0 })).status).toBe(200);
  });
});

describe('access', () => {
  it('keeps other organizations and locations out', async () => {
    const w = await pos();
    const other = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const s = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1')], [cash(376304)]);
    expect((await call(ctx.app, 'GET', `/v1/pos/sales/${s.body.id}`, other.org.auth)).status).toBe(404);
    expect((await call(ctx.app, 'GET', '/v1/pos/sales', other.org.auth)).body).toEqual([]);
    const elsewhere = await staff(ctx.app, w.org.auth, ['pos.read'], { type: 'location', id: w.w1 });
    expect((await call(ctx.app, 'GET', `/v1/pos/sales/${s.body.id}`, elsewhere.auth)).status).toBe(403);
    expect((await call(ctx.app, 'GET', '/v1/pos/sales', elsewhere.auth)).body).toEqual([]);
    expect(SUPERVISOR_PERMS).toContain('pos.refund.approve');
  });

  it('audits sales and returns', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const s = await sell(ctx.app, w.cashier.auth, w.reg1, [line(w, '1')], [cash(376304)]);
    const log = await call(ctx.app, 'GET', `/v1/audit-log?entityType=pos_sale&entityId=${s.body.id}`, w.org.auth);
    expect(log.body[0]).toMatchObject({ action: 'pos.sale', actorUserId: w.cashier.userId });
  });
});

describe('quote', () => {
  it('prices a cart exactly as the sale then charges, without creating anything', async () => {
    const w = await pos();
    await openSession(ctx.app, w.cashier.auth, w.reg1);
    const lines = [{ variantId: w.fabric.variantId, quantity: '7.5' }, { variantId: w.inclusive.variantId, quantity: '3', discount: { type: 'amount', amountMinor: 1 } }];
    const q = await call(ctx.app, 'POST', `/v1/pos/registers/${w.reg1}/quote`, w.cashier.auth, { lines });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ currency: 'NGN', minorUnit: 2, subtotalMinor: 2625375 + 10002, discountMinor: 1, taxMinor: 196903 + 698, totalMinor: 2822278 + 10001, sellable: true });
    expect(q.body.lines[0]).toMatchObject({ unitPrice: '3500.5', taxCode: 'VAT75', grossMinor: 2625375, taxMinor: 196903, totalMinor: 2822278, available: '100', insufficientStock: false });

    // The sale charges exactly the quoted total, line by line.
    const sale = await sell(ctx.app, w.cashier.auth, w.reg1, lines, [cash(q.body.totalMinor)], { expectedTotalMinor: q.body.totalMinor });
    expect(sale.status).toBe(201);
    expect(sale.body.lines.map((l: any) => [l.grossMinor, l.discountMinor, l.taxMinor, l.totalMinor])).toEqual(q.body.lines.map((l: any) => [l.grossMinor, l.discountMinor, l.taxMinor, l.totalMinor]));
    expect(sale.body.totalMinor).toBe(q.body.totalMinor);

    // Nothing was created by quoting, and the quote reflects the stock now taken.
    const before = (await ctx.db.query('SELECT count(*)::int AS n FROM pos_sales WHERE organization_id = $1', [w.org.organizationId])).rows[0].n;
    const q2 = await call(ctx.app, 'POST', `/v1/pos/registers/${w.reg1}/quote`, w.cashier.auth, { lines: [{ variantId: w.fabric.variantId, quantity: '1' }] });
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM pos_sales WHERE organization_id = $1', [w.org.organizationId])).rows[0].n).toBe(before);
    expect(q2.body.lines[0].available).toBe('92.5');
  });

  it('warns about missing stock without refusing, applies the same discount rules, and needs sell permission', async () => {
    const w = await pos('3');
    const short = await call(ctx.app, 'POST', `/v1/pos/registers/${w.reg1}/quote`, w.cashier.auth, { lines: [{ variantId: w.fabric.variantId, quantity: '5' }] });
    expect(short.status).toBe(200);
    expect(short.body.lines[0]).toMatchObject({ available: '3', insufficientStock: true });
    expect(short.body.sellable).toBe(false);
    const q = (extra: any, auth = w.cashier.auth) => call(ctx.app, 'POST', `/v1/pos/registers/${w.reg1}/quote`, auth, { lines: [{ variantId: w.fabric.variantId, quantity: '1', ...extra }] });
    expect((await q({ discount: { type: 'percent', basisPoints: 500 } })).status).toBe(200);
    expect((await q({ discount: { type: 'percent', basisPoints: 2000 } })).status).toBe(403);               // over the register limit
    expect((await q({ discount: { type: 'percent', basisPoints: 2000 } }, w.supervisor.auth)).status).toBe(200);   // may override
    const noDiscount = await staff(ctx.app, w.org.auth, ['pos.sell'], { type: 'location', id: w.shop });
    expect((await q({ discount: { type: 'percent', basisPoints: 100 } }, noDiscount.auth)).status).toBe(403);
    const readOnly = await staff(ctx.app, w.org.auth, ['pos.read'], { type: 'location', id: w.shop });
    expect((await q({}, readOnly.auth)).status).toBe(403);
    expect((await call(ctx.app, 'POST', `/v1/pos/registers/${w.reg1}/quote`, (await newOrg(ctx.db)).auth, { lines: [{ variantId: w.fabric.variantId, quantity: '1' }] })).status).toBe(404);
    const unpriced = await call(ctx.app, 'POST', '/v1/products', w.org.auth, { name: 'NoPrice', baseUnitId: w.m, variants: [{ sku: 'NP-Q' }] });
    expect((await q({ variantId: unpriced.body.variantIds[0] })).status).toBe(422);
  });
});
