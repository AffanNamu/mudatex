import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, staff } from './helpers.js';
import { balance } from './inventory-helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

async function ready() {
  const s = await shopWorld(ctx);
  await goLive(ctx, s);
  await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
  // a wholesale price list: 3,000 a metre instead of 3,500.50
  const list = await call(ctx.app, 'POST', '/v1/pricing/price-lists', s.a, { legalEntityId: s.w.ng, name: 'Wholesale NGN', currency: 'NGN' });
  await call(ctx.app, 'PUT', `/v1/pricing/price-lists/${list.body.id}/items`, s.a, { variantId: s.w.fabric.variantId, unitPrice: '3000', taxCodeId: s.w.vat });
  const c = await shopper(`tr-${uniq()}@example.test`);
  await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Hajiya Zainab' });
  const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'Shop', recipient: 'Zainab', phone: '+2348011111111', line1: '1 Kwari', city: 'Kano', state: 'Kano', countryCode: 'NG' });
  const apply = () => call(ctx.app, 'POST', `/shop/${s.slug}/me/trade`, c.auth, { businessName: 'Zainab Fabrics', taxId: 'TIN123' });
  const decide = async (body: Record<string, unknown>) => {
    const queue = await call(ctx.app, 'GET', '/v1/trade-accounts', s.a);
    const mine = queue.body.find((t: any) => t.email === c.email);
    return call(ctx.app, 'POST', `/v1/trade-accounts/${mine.id}/decision`, s.a, body);
  };
  const approve = (extra: Record<string, unknown> = {}) => decide({ status: 'approved', priceListId: list.body.id, creditLimitMinor: 5_000_000, paymentTermsDays: 30, ...extra });
  const order = (qty: string, method = 'account', who = c, address = addr.body.id) =>
    call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...who.auth, 'idempotency-key': crypto.randomUUID() }, { lines: [{ variantId: s.w.fabric.variantId, quantity: qty }], addressId: address, paymentMethod: method });
  return { s, c, list: list.body.id as string, apply, decide, approve, order, addressId: addr.body.id as string };
}

describe('trade accounts', () => {
  it('are applied for, approved by staff with a price list, credit and terms, and then priced from that list', async () => {
    const r = await ready();
    expect((await r.order('1')).status).toBe(422); // no account yet
    const applied = await r.apply();
    expect(applied.status).toBe(201);
    expect((await r.apply()).status).toBe(409);
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/trade`, r.c.auth)).body).toMatchObject({ status: 'pending', businessName: 'Zainab Fabrics' });
    expect((await r.order('1')).status).toBe(422); // still pending

    expect((await r.decide({ status: 'approved' })).status).toBe(422); // needs a price list
    expect((await r.approve()).body.status).toBe('approved');
    const line = [{ variantId: r.s.w.fabric.variantId, quantity: '2' }];
    // 2 x 3,000 + 7.5% = 6,450 for the wholesale buyer; 7,526.08 for everyone else
    const trade = await call(ctx.app, 'POST', `/shop/${r.s.slug}/basket`, r.c.auth, { lines: line });
    expect(trade.body).toMatchObject({ subtotalMinor: 645000, trade: { creditAvailableMinor: 5_000_000 } });
    const retail = await call(ctx.app, 'POST', `/shop/${r.s.slug}/basket`, undefined, { lines: line });
    expect(retail.body).toMatchObject({ subtotalMinor: 752608, trade: null });
    // the product page for the public still shows the retail price
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/products/ankara-wax`, undefined)).body.variants[0].priceMinor).toBe(376304);
  });

  it('take orders on account within the credit limit, confirm them at once and keep a statement', async () => {
    const r = await ready();
    await r.apply(); await r.approve({ creditLimitMinor: 2_000_000 });
    const o = await r.order('3'); // 3 x 3,000 = 9,000 + 7.5% = 9,675.00 + 1,000 delivery = 10,675.00
    expect(o.status).toBe(201);
    expect(o.body).toMatchObject({ status: 'confirmed', paymentMethod: 'account', totalMinor: 1067500, paidMinor: 0 });
    expect(o.body.dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await balance(ctx.app, r.s.a, { locationId: r.s.w.shop, variantId: r.s.w.fabric.variantId })).reserved).toBe('3');
    let acct = (await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/trade`, r.c.auth)).body;
    expect(acct).toMatchObject({ creditUsedMinor: 1067500, creditAvailableMinor: 932500 });

    // over the limit
    const big = await r.order('3');
    expect(big.status).toBe(422);
    expect(big.body.message).toMatch(/credit limit/);
    expect((await r.order('1', 'bank_transfer')).status).toBe(201); // ordinary payment still possible, at trade prices, outside the credit

    // staff ship it, then record part payments
    await call(ctx.app, 'POST', `/v1/sales-orders/${o.body.id}/steps`, r.s.a, { action: 'ship' });
    const pay = (amountMinor: number, reference: string) => call(ctx.app, 'POST', `/v1/sales-orders/${o.body.id}/payments`, r.s.a, { method: 'bank_transfer', reference, amountMinor });
    expect((await pay(500000, `T-${uniq()}`)).body).toMatchObject({ status: 'shipped', paidMinor: 500000 });
    expect((await pay(9_999_999, `T-${uniq()}`)).status).toBe(422);
    expect((await pay(567500, `T-${uniq()}`)).body.paidMinor).toBe(1067500);
    acct = (await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/trade`, r.c.auth)).body;
    expect(acct.creditUsedMinor).toBe(0);
    expect(acct.statement.map((l: any) => [l.kind, l.amountMinor, l.balanceMinor])).toEqual([['order', 1067500, 1067500], ['payment', 500000, 567500], ['payment', 567500, 0]]);
  });

  it('give the credit back when an order is cancelled, and stop when the account is suspended', async () => {
    const r = await ready();
    await r.apply(); await r.approve({ creditLimitMinor: 1_100_000 });
    const o = await r.order('3');
    expect((await r.order('3')).status).toBe(422);
    await call(ctx.app, 'POST', `/shop/${r.s.slug}/me/orders/${o.body.orderNo}/cancel`, r.c.auth);
    expect((await call(ctx.app, 'POST', `/v1/sales-orders/${o.body.id}/cancel`, r.s.a, { reason: 'Customer asked to cancel' })).body.status).toBe('cancelled');
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/trade`, r.c.auth)).body.creditUsedMinor).toBe(0);
    expect((await r.order('3')).status).toBe(201);

    await r.decide({ status: 'suspended', note: 'Overdue' });
    expect((await r.order('1')).status).toBe(422);
    const basket = await call(ctx.app, 'POST', `/shop/${r.s.slug}/basket`, r.c.auth, { lines: [{ variantId: r.s.w.fabric.variantId, quantity: '1' }] });
    expect(basket.body.subtotalMinor).toBe(376304); // back to retail
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/trade`, r.c.auth)).body).toMatchObject({ status: 'suspended' });
  });

  it('allow a rejected business to apply again, and keep applicants apart', async () => {
    const r = await ready();
    await r.apply();
    await r.decide({ status: 'rejected', note: 'Please send your registration' });
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/trade`, r.c.auth)).body).toMatchObject({ status: 'rejected', note: 'Please send your registration' });
    expect((await r.apply()).status).toBe(201);
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/trade`, r.c.auth)).body.status).toBe('pending');
    const other = await shopper(`tr2-${uniq()}@example.test`);
    await call(ctx.app, 'POST', `/shop/${r.s.slug}/me`, other.auth, { fullName: 'Other Buyer' });
    expect((await call(ctx.app, 'GET', `/shop/${r.s.slug}/me/trade`, other.auth)).status).toBe(404);
  });

  it('can only be managed by authorised staff, with a price list of the right company and currency', async () => {
    const r = await ready();
    await r.apply();
    const queue = (await call(ctx.app, 'GET', '/v1/trade-accounts?status=pending', r.s.a)).body;
    const id = queue.find((t: any) => t.email === r.c.email).id;
    const nobody = await staff(ctx.app, r.s.a, ['catalog.read'], { type: 'group' });
    expect((await call(ctx.app, 'GET', '/v1/trade-accounts', nobody.auth)).body).toEqual([]);
    expect((await call(ctx.app, 'POST', `/v1/trade-accounts/${id}/decision`, nobody.auth, { status: 'approved', priceListId: r.list })).status).toBe(403);
    const gh = await staff(ctx.app, r.s.a, ['trade.manage'], { type: 'legal_entity', id: r.s.w.gh });
    expect((await call(ctx.app, 'POST', `/v1/trade-accounts/${id}/decision`, gh.auth, { status: 'approved', priceListId: r.list })).status).toBe(403);
    const ghList = await call(ctx.app, 'POST', '/v1/pricing/price-lists', r.s.a, { legalEntityId: r.s.w.gh, name: 'GH Wholesale', currency: 'GHS' });
    expect((await call(ctx.app, 'POST', `/v1/trade-accounts/${id}/decision`, r.s.a, { status: 'approved', priceListId: ghList.body.id })).status).toBe(422);
    const ng = await staff(ctx.app, r.s.a, ['trade.manage'], { type: 'legal_entity', id: r.s.w.ng });
    expect((await call(ctx.app, 'POST', `/v1/trade-accounts/${id}/decision`, ng.auth, { status: 'approved', priceListId: r.list, creditLimitMinor: 100 })).status).toBe(200);
  });
});
