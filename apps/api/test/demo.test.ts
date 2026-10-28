import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newOrg, setupApp, staff } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

describe('sample data', () => {
  it('fills an empty system with a working company, catalogue, till and live store', async () => {
    const org = await newOrg(ctx.db);
    const r = await call(ctx.app, 'POST', '/v1/demo/seed', org.auth);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ storefront: expect.stringMatching(/^demo/), products: 12 });
    const slug = r.body.storefront as string;

    // the public shop answers, with prices, tax and stock worked out by the server
    const home = await call(ctx.app, 'GET', `/shop/${slug}`, undefined);
    expect(home.status).toBe(200);
    expect(home.body.departments.map((d: any) => d.slug)).toEqual(['ankara', 'lace', 'brocade', 'atampa', 'plain']);
    const list = await call(ctx.app, 'GET', `/shop/${slug}/products?limit=60`, undefined);
    expect(list.body.total).toBe(12);
    const royal = list.body.items.find((i: any) => i.slug === 'royal-ankara-wax-print');
    expect(royal).toMatchObject({ priceMinor: 451500, inStock: true, badges: ['Best seller'] }); // 4,200 + 7.5% = 4,515.00
    expect(list.body.items.find((i: any) => i.title === 'Java Print, Garden')).toMatchObject({ inStock: false });
    const detail = await call(ctx.app, 'GET', `/shop/${slug}/products/royal-ankara-wax-print`, undefined);
    expect(detail.body.i18n.fr.title).toBe('Wax Ankara Royal');
    expect(home.body.departments[1].i18n).toEqual({ fr: { name: 'Dentelle' }, ha: { name: 'Leshi' } });
    expect(detail.body.conversions).toEqual([expect.objectContaining({ fromCode: 'roll', toCode: 'm', factor: '50' })]);
    expect((await call(ctx.app, 'POST', `/shop/${slug}/delivery-quote`, undefined, { countryCode: 'NG', state: 'Kano', subtotalMinor: 100 })).body).toMatchObject({ feeMinor: 150000 });

    // the till is ready to open and stock is on the shelves
    const regs = await call(ctx.app, 'GET', '/v1/pos/registers', org.auth);
    expect(regs.body).toEqual([expect.objectContaining({ code: 'KWARI1' })]);
    const rec = await call(ctx.app, 'GET', '/v1/inventory/reconciliation', org.auth);
    expect(rec.body.consistent).toBe(true);
  });

  it('refuses to run twice, and on a system that already has data', async () => {
    const org = await newOrg(ctx.db);
    expect((await call(ctx.app, 'POST', '/v1/demo/seed', org.auth)).status).toBe(201);
    expect((await call(ctx.app, 'POST', '/v1/demo/seed', org.auth)).status).toBe(409);
    const used = await newOrg(ctx.db);
    await call(ctx.app, 'POST', '/v1/legal-entities', used.auth, { name: 'Real Co', countryCode: 'NG', functionalCurrency: 'NGN' });
    expect((await call(ctx.app, 'POST', '/v1/demo/seed', used.auth)).status).toBe(409);
  });

  it('is limited to people who could create all of this themselves', async () => {
    const org = await newOrg(ctx.db);
    const clerk = await staff(ctx.app, org.auth, ['catalog.read'], { type: 'group' });
    const r = await call(ctx.app, 'POST', '/v1/demo/seed', clerk.auth);
    expect(r.status).toBe(403);
    // nothing half-made is left behind
    expect((await call(ctx.app, 'GET', '/v1/legal-entities', org.auth)).body).toEqual([]);
  });
});
