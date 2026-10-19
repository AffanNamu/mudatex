import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../src/auth/permissions.js';
import { loadConfig } from '../src/config.js';
import { call, newOrg, setupApp, staff } from './helpers.js';
import { buildWorld, cmd, receive } from './inventory-helpers.js';
import { buildPosWorld, openSession } from './pos-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

describe('/me/grants', () => {
  it('lists what the signed-in person may do, by scope, and drops revoked or expired grants', async () => {
    const w = await buildWorld(ctx.app, await newOrg(ctx.db));
    const s = await staff(ctx.app, w.org.auth, ['pos.sell', 'pos.read'], { type: 'location', id: w.shop });
    const c = await staff(ctx.app, w.org.auth, ['pos.read'], { type: 'country', countryCode: 'NG' });
    const mine = await call(ctx.app, 'GET', '/v1/me/grants', s.auth);
    expect(mine.body.user).toMatchObject({ id: s.userId, organizationId: w.org.organizationId });
    expect(mine.body.user.email).toMatch(/@example\.test$/);
    expect(Object.keys(mine.body.permissions).sort()).toEqual(['pos.read', 'pos.sell']);
    expect(mine.body.permissions['pos.sell']).toEqual([{ scope: 'location', id: w.shop, role: expect.stringMatching(/^r_/) }]);
    expect((await call(ctx.app, 'GET', '/v1/me/grants', c.auth)).body.permissions['pos.read']).toEqual([expect.objectContaining({ scope: 'country', country: 'NG' })]);
    expect(Object.keys((await call(ctx.app, 'GET', '/v1/me/grants', w.org.auth)).body.permissions)).toEqual([...PERMISSIONS].sort());   // the administrator holds everything

    await call(ctx.app, 'DELETE', `/v1/memberships/${s.membershipId}`, w.org.auth);
    expect((await call(ctx.app, 'GET', '/v1/me/grants', s.auth)).body.permissions).toEqual({});
    expect((await call(ctx.app, 'GET', '/v1/permissions', s.auth)).body).toEqual([...PERMISSIONS]);
  });
});

describe('identity lists', () => {
  it('are for administrators only and stay inside the organization', async () => {
    const w = await buildWorld(ctx.app, await newOrg(ctx.db));
    const other = await newOrg(ctx.db);
    const s = await staff(ctx.app, w.org.auth, ['pos.read'], { type: 'group' });
    for (const path of ['/v1/users', '/v1/roles', '/v1/memberships']) expect((await call(ctx.app, 'GET', path, s.auth)).status).toBe(403);
    const users = await call(ctx.app, 'GET', '/v1/users', w.org.auth);
    expect(users.body.map((u: any) => u.id).sort()).toEqual([w.org.userId, s.userId].sort());
    expect((await call(ctx.app, 'GET', '/v1/users', other.auth)).body).toHaveLength(1);
    const roles = await call(ctx.app, 'GET', '/v1/roles', w.org.auth);
    expect(roles.body.find((r: any) => r.key === 'group_admin').permissions).toEqual([...PERMISSIONS].sort());
    expect(roles.body.find((r: any) => r.id === s.roleId).permissions).toEqual(['pos.read']);

    const ms = await call(ctx.app, 'GET', `/v1/memberships?userId=${s.userId}`, w.org.auth);
    expect(ms.body).toEqual([expect.objectContaining({ userId: s.userId, scopeType: 'group', roleId: s.roleId })]);
    await call(ctx.app, 'DELETE', `/v1/memberships/${s.membershipId}`, w.org.auth);
    expect((await call(ctx.app, 'GET', `/v1/memberships?userId=${s.userId}`, w.org.auth)).body).toEqual([]);
    expect((await call(ctx.app, 'GET', `/v1/memberships?userId=${s.userId}&includeRevoked=true`, w.org.auth)).body[0].revokedAt).not.toBeNull();
  });
});

describe('POS lists', () => {
  it('shows registers and price lists only where the caller can use them, with who has the session', async () => {
    const w = await buildPosWorld(ctx.app, await buildWorld(ctx.app, await newOrg(ctx.db)));
    const session = await openSession(ctx.app, w.cashier.auth, w.reg1);
    const regs = await call(ctx.app, 'GET', '/v1/pos/registers', w.cashier.auth);
    expect(regs.body.map((r: any) => r.code)).toEqual(['SHOP1', 'SHOP2']);
    expect(regs.body[0]).toMatchObject({ id: w.reg1, currency: 'NGN', minorUnit: 2, maxDiscountBps: 1000, openSessionId: session, openSessionCashierId: w.cashier.userId });
    expect(regs.body[1]).toMatchObject({ openSessionId: null });
    const elsewhere = await staff(ctx.app, w.org.auth, ['pos.sell', 'pos.read'], { type: 'location', id: w.w1 });
    expect((await call(ctx.app, 'GET', '/v1/pos/registers', elsewhere.auth)).body).toEqual([]);
    expect((await call(ctx.app, 'GET', '/v1/pricing/price-lists', elsewhere.auth)).body).toEqual([]);
    const lists = await call(ctx.app, 'GET', '/v1/pricing/price-lists', w.cashier.auth);
    expect(lists.body).toEqual([]);                                                                       // the cashier is scoped to a location, not the legal entity
    expect((await call(ctx.app, 'GET', '/v1/pricing/price-lists', w.org.auth)).body).toEqual([{ id: w.priceList, legalEntityId: w.ng, name: 'Retail NGN', currency: 'NGN' }]);
    expect((await call(ctx.app, 'GET', '/v1/pos/registers', (await newOrg(ctx.db)).auth)).body).toEqual([]);
  });

  it('gives a terminal its catalogue with current price, tax and free stock, and searches by name, SKU or barcode', async () => {
    const w = await buildPosWorld(ctx.app, await buildWorld(ctx.app, await newOrg(ctx.db)), '40');
    await cmd(ctx.app, w.org.auth, '/v1/inventory/reservations', { locationId: w.shop, variantId: w.fabric.variantId, quantity: '15', referenceType: 'order', referenceId: 'O-1' });
    const all = await call(ctx.app, 'GET', `/v1/pos/registers/${w.reg1}/catalog`, w.cashier.auth);
    const fabric = all.body.find((x: any) => x.variantId === w.fabric.variantId);
    expect(fabric).toMatchObject({ unitPrice: '3500.5000', taxCode: 'VAT75', taxRate: '0.075000', taxInclusive: false, unit: 'm', available: '25.000000', tracking: 'none' });
    expect(all.body.find((x: any) => x.variantId === w.inclusive.variantId)).toMatchObject({ taxInclusive: true, available: '40.000000' });
    expect(all.body.every((x: any) => x.unitPrice !== undefined)).toBe(true);                             // unpriced variants are not for sale

    const byName = await call(ctx.app, 'GET', `/v1/pos/registers/${w.reg1}/catalog?q=fabric`, w.cashier.auth);
    expect(byName.body.map((x: any) => x.variantId)).toEqual([w.fabric.variantId]);
    const sku = fabric.sku as string;
    expect((await call(ctx.app, 'GET', `/v1/pos/registers/${w.reg1}/catalog?q=${sku.slice(0, 6).toLowerCase()}`, w.cashier.auth)).body.length).toBeGreaterThan(0);
    await call(ctx.app, 'POST', '/v1/products', w.org.auth, { name: 'Scan me', baseUnitId: w.m, variants: [{ sku: 'SCAN-1', barcodes: ['6001234567890'] }] });
    const scan = (await call(ctx.app, 'GET', `/v1/products?limit=200`, w.org.auth)).body.find((p: any) => p.name === 'Scan me').variants[0].id;
    await call(ctx.app, 'PUT', `/v1/pricing/price-lists/${w.priceList}/items`, w.org.auth, { variantId: scan, unitPrice: '10' });
    expect((await call(ctx.app, 'GET', `/v1/pos/registers/${w.reg1}/catalog?q=6001234567890`, w.cashier.auth)).body.map((x: any) => x.variantId)).toEqual([scan]);
    expect((await call(ctx.app, 'GET', `/v1/pos/registers/${w.reg1}/catalog?q=zzz-nothing`, w.cashier.auth)).body).toEqual([]);

    const noSell = await staff(ctx.app, w.org.auth, ['pos.read'], { type: 'location', id: w.shop });
    expect((await call(ctx.app, 'GET', `/v1/pos/registers/${w.reg1}/catalog`, noSell.auth)).status).toBe(403);
    expect((await call(ctx.app, 'GET', `/v1/pos/registers/${w.reg1}/catalog`, (await newOrg(ctx.db)).auth)).status).toBe(404);
    expect(w.supervisor).toBeTruthy();
    expect(await receive(ctx.app, w.org.auth, w.shop, w.fabric.variantId, '1')).toBeTruthy();
  });
});

describe('development sign-in', () => {
  it('mints a working token for an existing active user when enabled', async () => {
    const org = await newOrg(ctx.db);
    const email = `${org.sub}@example.test`;
    const r = await call(ctx.app, 'POST', '/v1/dev/token', undefined, { email });
    expect(r.status).toBe(200);
    expect((await call(ctx.app, 'GET', '/v1/me', { authorization: `Bearer ${r.body.token}` })).body).toMatchObject({ userId: org.userId });
    expect((await call(ctx.app, 'POST', '/v1/dev/token', undefined, { email: 'nobody@example.test' })).status).toBe(404);
    await call(ctx.app, 'POST', '/v1/roles', org.auth, { key: 'x1', name: 'X', permissions: ['org.read'] });
    const s = await staff(ctx.app, org.auth, ['org.read'], { type: 'group' });
    await call(ctx.app, 'POST', `/v1/users/${s.userId}/suspend`, org.auth);
    const sus = (await ctx.db.query('SELECT email FROM users WHERE id = $1', [s.userId])).rows[0].email;
    expect((await call(ctx.app, 'POST', '/v1/dev/token', undefined, { email: sus })).status).toBe(404);
  });

  it('does not exist unless explicitly enabled, and production refuses to start with it', async () => {
    const off = await setupApp({ DEV_TOKEN_ENDPOINT: 'false' });
    try {
      expect((await call(off.app, 'POST', '/v1/dev/token', undefined, { email: 'a@example.test' })).status).toBe(404);
    } finally { await off.close(); }
    const prod = { NODE_ENV: 'production', DATABASE_URL: 'x', AUTH_JWKS_URL: 'https://idp.example.com/jwks', AUTH_ISSUER: 'i', AUTH_AUDIENCE: 'a' };
    expect(() => loadConfig({ ...prod, DEV_TOKEN_ENDPOINT: 'true' })).toThrow(/DEV_TOKEN_ENDPOINT/);
    expect(() => loadConfig(prod)).not.toThrow();
  });
});
