import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, staff } from './helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

describe('the customer desk', () => {
  it('finds shoppers, shows what they bought, blocks and unblocks them, and exports what is held', async () => {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { contact: { bankName: 'Test Bank', accountName: 'Textiles Ltd', accountNumber: '0123456789' } });
    await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
    const tag = uniq();
    const c = await shopper(`desk-${tag}@example.test`);
    await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: `Hauwa Desk ${tag}`, phone: '+2348022222222' });
    const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Hauwa', phone: '+2348022222222', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
    const order = await call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...c.auth, 'idempotency-key': crypto.randomUUID() }, { lines: [{ variantId: s.w.fabric.variantId, quantity: '1' }], addressId: addr.body.id, paymentMethod: 'bank_transfer' });
    expect(order.status).toBe(201);

    const found = await call(ctx.app, 'GET', `/v1/customers?q=${encodeURIComponent(`desk ${tag}`.replace(' ', ' '))}`, s.a);
    expect(found.body.total).toBe(1);
    expect(found.body.items[0]).toMatchObject({ fullName: `Hauwa Desk ${tag}`, email: `desk-${tag}@example.test`, orders: 1, status: 'active', isTrade: false });
    expect((await call(ctx.app, 'GET', '/v1/customers?q=%25', s.a)).body.total).toBe(0);   // % is a letter, not a wildcard
    const id = found.body.items[0].id;

    const d = await call(ctx.app, 'GET', `/v1/customers/${id}`, s.a);
    expect(d.body).toMatchObject({ phone: '+2348022222222', status: 'active', addresses: [expect.objectContaining({ city: 'Kano', isDefault: true })], orders: [expect.objectContaining({ orderNo: order.body.orderNo, status: 'pending_payment' })] });

    // blocking needs a reason, takes effect at once, and is lifted by unblocking
    expect((await call(ctx.app, 'POST', `/v1/customers/${id}/block`, s.a, {})).status).toBe(422);
    const blocked = await call(ctx.app, 'POST', `/v1/customers/${id}/block`, s.a, { reason: 'Chargeback fraud' });
    expect(blocked.body).toMatchObject({ status: 'blocked', blockedReason: 'Chargeback fraud' });
    expect((await call(ctx.app, 'GET', `/shop/${s.slug}/me`, c.auth)).status).toBe(403);
    expect((await call(ctx.app, 'GET', `/v1/customers?status=blocked&q=${tag}`, s.a)).body.total).toBe(1);
    const open = await call(ctx.app, 'POST', `/v1/customers/${id}/unblock`, s.a, {});
    expect(open.body).toMatchObject({ status: 'active', blockedReason: null });
    expect((await call(ctx.app, 'GET', `/shop/${s.slug}/me`, c.auth)).status).toBe(200);

    const exp = await ctx.app.inject({ method: 'GET', url: `/v1/customers/${id}/export`, headers: s.a });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-disposition']).toContain('customer-');
    expect(JSON.parse(exp.body)).toMatchObject({ email: `desk-${tag}@example.test`, addresses: [expect.anything()] });
    const audit = await ctx.db.query(`SELECT action FROM audit_log WHERE entity_type = 'customer' AND entity_id = $1 ORDER BY id`, [id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['customer.block', 'customer.unblock', 'customer.export']);
  });

  it('is for people with the whole-company permission only, and stays inside the company', async () => {
    const a = await shopWorld(ctx); const b = await shopWorld(ctx);
    const c = await shopper(`other-${uniq()}@example.test`);
    await call(ctx.app, 'POST', `/shop/${b.slug}/me`, c.auth, { fullName: 'Elsewhere Customer' }).catch(() => undefined);
    await goLive(ctx, b);
    await call(ctx.app, 'POST', `/shop/${b.slug}/me`, c.auth, { fullName: 'Elsewhere Customer' });
    const row = (await call(ctx.app, 'GET', '/v1/customers?q=Elsewhere', b.a)).body.items[0];
    expect(row).toBeDefined();
    expect((await call(ctx.app, 'GET', `/v1/customers/${row.id}`, a.a)).status).toBe(404);   // another company's customer
    const entityOnly = await staff(ctx.app, a.a, ['customers.manage'], { type: 'legal_entity', id: a.w.ng });
    expect((await call(ctx.app, 'GET', '/v1/customers', entityOnly.auth)).status).toBe(403);
    const group = await staff(ctx.app, a.a, ['customers.manage'], { type: 'group' });
    expect((await call(ctx.app, 'GET', '/v1/customers', group.auth)).status).toBe(200);
  });
});
