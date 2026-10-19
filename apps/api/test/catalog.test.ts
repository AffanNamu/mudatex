import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newOrg, setupApp, staff } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

async function units(auth: any) {
  const m = await call(ctx.app, 'POST', '/v1/units', auth, { code: 'm', name: 'Metre', kind: 'decimal', precision: 2 });
  const yd = await call(ctx.app, 'POST', '/v1/units', auth, { code: 'yd', name: 'Yard', kind: 'decimal', precision: 2 });
  const roll = await call(ctx.app, 'POST', '/v1/units', auth, { code: 'roll', name: 'Roll', kind: 'discrete', precision: 0 });
  return { m: m.body.id as string, yd: yd.body.id as string, roll: roll.body.id as string };
}

describe('catalogue', () => {
  it('creates a textile product with variants, barcodes and explicit conversions', async () => {
    const org = await newOrg(ctx.db);
    const u = await units(org.auth);
    const res = await call(ctx.app, 'POST', '/v1/products', org.auth, {
      name: 'Ankara Wax Print',
      baseUnitId: u.yd,
      attributes: { fabricFamily: 'cotton wax', widthCm: 114 },
      variants: [
        { sku: 'ANK-RED', attributes: { colour: 'red' }, barcodes: ['600000000001'] },
        { sku: 'ANK-BLU', attributes: { colour: 'blue' }, barcodes: ['600000000002'] },
      ],
      conversions: [{ fromUnitId: u.roll, toUnitId: u.yd, factor: '6' }, { fromUnitId: u.yd, toUnitId: u.m, factor: '0.9144' }],
    });
    expect(res.status).toBe(201);

    const list = await call(ctx.app, 'GET', '/v1/products', org.auth);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].variants.map((v: any) => v.sku)).toEqual(['ANK-BLU', 'ANK-RED']);
    expect(list.body[0].variants[1].barcodes).toEqual(['600000000001']);
  });

  it('enforces SKU and barcode uniqueness within an organization, not across organizations', async () => {
    const a = await newOrg(ctx.db);
    const ua = await units(a.auth);
    const body = (sku: string, barcode: string) => ({ name: 'P', baseUnitId: ua.m, variants: [{ sku, barcodes: [barcode] }] });
    expect((await call(ctx.app, 'POST', '/v1/products', a.auth, body('S1', 'B1'))).status).toBe(201);
    expect((await call(ctx.app, 'POST', '/v1/products', a.auth, body('S1', 'B2'))).status).toBe(409);
    expect((await call(ctx.app, 'POST', '/v1/products', a.auth, body('S2', 'B1'))).status).toBe(409);
    // Failed creates leave nothing behind.
    expect((await call(ctx.app, 'GET', '/v1/products', a.auth)).body).toHaveLength(1);

    const b = await newOrg(ctx.db);
    const ub = await units(b.auth);
    expect((await call(ctx.app, 'POST', '/v1/products', b.auth, { name: 'P', baseUnitId: ub.m, variants: [{ sku: 'S1', barcodes: ['B1'] }] })).status).toBe(201);
  });

  it('rejects duplicates inside one request and units from another organization', async () => {
    const a = await newOrg(ctx.db);
    const b = await newOrg(ctx.db);
    const ua = await units(a.auth);
    const ub = await units(b.auth);
    const dup = await call(ctx.app, 'POST', '/v1/products', a.auth, { name: 'P', baseUnitId: ua.m, variants: [{ sku: 'X' }, { sku: 'X' }] });
    expect(dup.status).toBe(422);
    const foreign = await call(ctx.app, 'POST', '/v1/products', a.auth, { name: 'P', baseUnitId: ub.m, variants: [{ sku: 'Y' }] });
    expect(foreign.status).toBe(422);
  });

  it('rejects invalid unit definitions and conversion factors', async () => {
    const org = await newOrg(ctx.db);
    expect((await call(ctx.app, 'POST', '/v1/units', org.auth, { code: 'pcs', name: 'Pieces', kind: 'discrete', precision: 2 })).status).toBe(400);
    const u = await units(org.auth);
    for (const factor of ['0', '-1', '1e3', 'abc']) {
      const r = await call(ctx.app, 'POST', '/v1/products', org.auth, { name: 'P', baseUnitId: u.m, variants: [{ sku: `F${factor}` }], conversions: [{ fromUnitId: u.yd, toUnitId: u.m, factor }] });
      expect([400, 422]).toContain(r.status);
    }
    const same = await call(ctx.app, 'POST', '/v1/products', org.auth, { name: 'P', baseUnitId: u.m, variants: [{ sku: 'SAME' }], conversions: [{ fromUnitId: u.m, toUnitId: u.m, factor: '1' }] });
    expect(same.status).toBe(422);
  });

  it('archives instead of deleting, keeping history readable', async () => {
    const org = await newOrg(ctx.db);
    const u = await units(org.auth);
    const p = await call(ctx.app, 'POST', '/v1/products', org.auth, { name: 'Old', baseUnitId: u.m, variants: [{ sku: 'OLD' }] });
    expect((await call(ctx.app, 'POST', `/v1/products/${p.body.id}/archive`, org.auth)).status).toBe(200);
    expect((await call(ctx.app, 'GET', '/v1/products', org.auth)).body).toEqual([]);
    const archived = await call(ctx.app, 'GET', '/v1/products?status=archived', org.auth);
    expect(archived.body[0]).toMatchObject({ name: 'Old', status: 'archived' });
  });

  it('separates read from write access', async () => {
    const org = await newOrg(ctx.db);
    const u = await units(org.auth);
    const reader = await staff(ctx.app, org.auth, ['catalog.read'], { type: 'location', id: (await seedLocation(org)).id });
    const body = { name: 'P', baseUnitId: u.m, variants: [{ sku: 'RO' }] };
    expect((await call(ctx.app, 'GET', '/v1/products', reader.auth)).status).toBe(200);
    expect((await call(ctx.app, 'POST', '/v1/products', reader.auth, body)).status).toBe(403);
    const none = await staff(ctx.app, org.auth, ['org.read'], { type: 'group' });
    expect((await call(ctx.app, 'GET', '/v1/products', none.auth)).status).toBe(403);
    // Catalogue writes are organization-wide, so a narrower catalog.write grant is not enough.
    const narrow = await staff(ctx.app, org.auth, ['catalog.write'], { type: 'location', id: (await seedLocation(org)).id });
    expect((await call(ctx.app, 'POST', '/v1/products', narrow.auth, body)).status).toBe(403);
  });
});

async function seedLocation(org: Awaited<ReturnType<typeof newOrg>>) {
  const le = await call(ctx.app, 'POST', '/v1/legal-entities', org.auth, { name: `LE-${crypto.randomUUID()}`, countryCode: 'NG', functionalCurrency: 'NGN' });
  const loc = await call(ctx.app, 'POST', '/v1/locations', org.auth, { legalEntityId: le.body.id, type: 'branch', name: 'B', countryCode: 'NG', timezone: 'Africa/Lagos' });
  return loc.body as { id: string };
}
