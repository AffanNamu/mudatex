import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newOrg, setupApp, staff, token } from './helpers.js';
import { cmd, receive } from './inventory-helpers.js';
import { goLive, shopper, shopWorld, uniq } from './shop-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

describe('storefront administration', () => {
  it('stays invisible until published products exist and the store is live', async () => {
    const s = await shopWorld(ctx);
    expect((await call(ctx.app, 'GET', `/shop/${s.slug}`, undefined)).status).toBe(404);
    const early = await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { status: 'live' });
    expect(early.status).toBe(409);
    await goLive(ctx, s);
    const home = await call(ctx.app, 'GET', `/shop/${s.slug}`, undefined);
    expect(home.status).toBe(200);
    expect(home.body).toMatchObject({ name: 'Test Shop', currency: 'NGN', minorUnit: 2, contact: { whatsapp: '+2348000000000' } });
    expect(home.body.departments).toEqual([expect.objectContaining({ slug: 'fabrics', productCount: 1 })]);
    await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { status: 'closed' });
    expect((await call(ctx.app, 'GET', `/shop/${s.slug}`, undefined)).status).toBe(404);
  });

  it('refuses to publish an unpriced product, a foreign department or an insecure image', async () => {
    const s = await shopWorld(ctx);
    const unpriced = await call(ctx.app, 'POST', '/v1/products', s.a, { name: 'No price', baseUnitId: s.w.m, variants: [{ sku: `NP-${uniq()}` }] });
    expect((await s.publish(unpriced.body.id, { published: true })).status).toBe(409);
    // saved as a draft it is fine, and is listed as unpriced
    expect((await s.publish(unpriced.body.id, { published: false })).status).toBe(200);
    const list = await call(ctx.app, 'GET', `/v1/storefronts/${s.id}/products`, s.a);
    expect(list.body).toEqual([expect.objectContaining({ productName: 'No price', priced: false, published: false })]);

    const other = await shopWorld(ctx);
    expect((await s.publish(s.w.fabric.productId, { departmentId: other.deptId })).status).toBe(422);
    expect((await s.publish(s.w.fabric.productId, { images: ['http://img.example.test/a.jpg'] })).status).toBe(400);
  });

  it('is scoped by legal entity and needs its own permission', async () => {
    const s = await shopWorld(ctx);
    const ghStaff = await staff(ctx.app, s.a, ['storefront.manage'], { type: 'legal_entity', id: s.w.gh });
    expect((await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, ghStaff.auth, { name: 'Hijack' })).status).toBe(403);
    const none = await staff(ctx.app, s.a, ['catalog.read'], { type: 'group' });
    expect((await call(ctx.app, 'GET', `/v1/storefronts/${s.id}/departments`, none.auth)).status).toBe(403);
    const ngStaff = await staff(ctx.app, s.a, ['storefront.manage'], { type: 'legal_entity', id: s.w.ng });
    expect((await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, ngStaff.auth, { name: 'Renamed' })).body.name).toBe('Renamed');
    expect((await call(ctx.app, 'GET', '/v1/storefronts', ghStaff.auth)).body).toEqual([]);
    expect((await call(ctx.app, 'GET', '/v1/storefronts', ngStaff.auth)).body).toHaveLength(1);
  });

  it('keeps one store per organisation out of another organisation\'s reach', async () => {
    const s = await shopWorld(ctx);
    const other = await newOrg(ctx.db);
    expect((await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, other.auth, { name: 'Not yours' })).status).toBe(404);
  });

  it('checks stock locations and the price list belong to the legal entity', async () => {
    const s = await shopWorld(ctx);
    const bad = await call(ctx.app, 'POST', '/v1/storefronts', s.a, { legalEntityId: s.w.ng, slug: `x-${uniq()}`, name: 'Bad', priceListId: s.w.priceList, stockLocationIds: [s.w.g1] });
    expect(bad.status).toBe(422);
    const dup = await call(ctx.app, 'POST', '/v1/storefronts', s.a, { legalEntityId: s.w.ng, slug: s.slug, name: 'Dup', priceListId: s.w.priceList, stockLocationIds: [s.w.shop] });
    expect(dup.status).toBe(409);
  });
});

describe('public catalogue', () => {
  it('prices from the server including tax, and caps what it reveals about stock', async () => {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    const list = await call(ctx.app, 'GET', `/shop/${s.slug}/products`, undefined);
    expect(list.body.total).toBe(1);
    // 3500.50 + 7.5% VAT = 3762.5375 -> 3,763.04 (line rounded half-up to minor units)
    expect(list.body.items[0]).toMatchObject({ slug: 'ankara-wax', title: 'Ankara Wax', priceMinor: 376304, inStock: true, currency: 'NGN', department: { slug: 'fabrics' } });
    const detail = await call(ctx.app, 'GET', `/shop/${s.slug}/products/ankara-wax`, undefined);
    expect(detail.status).toBe(200);
    expect(detail.body.unit).toMatchObject({ code: 'm' });
    expect(detail.body.conversions).toEqual(expect.arrayContaining([expect.objectContaining({ fromCode: 'roll', toCode: 'm', factor: '50' })]));
    expect(detail.body.variants[0]).toMatchObject({ unitPrice: '3500.5', priceMinor: 376304, available: 100, inStock: true });
    // far more than the cap is on hand but only the cap is shown
    await receive(ctx.app, s.a, s.w.shop, s.w.fabric.variantId, '5000');
    const again = await call(ctx.app, 'GET', `/shop/${s.slug}/products/ankara-wax`, undefined);
    expect(again.body.variants[0].available).toBe(100);
  });

  it('does not offer reserved stock, other locations, quarantined rolls or unpublished products', async () => {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    // roll-tracked product with one roll that is then quarantined
    const roll = await receive(ctx.app, s.a, s.w.shop, s.w.rolled.variantId, '40', { lotCode: 'R-ONLY' });
    await s.publish(s.w.rolled.productId, { slug: 'rolled', title: 'Rolled', published: true });
    let detail = await call(ctx.app, 'GET', `/shop/${s.slug}/products/rolled`, undefined);
    expect(detail.body.variants[0]).toMatchObject({ available: 40, inStock: true });
    await cmd(ctx.app, s.a, `/v1/quality/lots/${roll.lines[0]!.lotId}/hold`, { reason: 'Colour fading suspected' });
    detail = await call(ctx.app, 'GET', `/shop/${s.slug}/products/rolled`, undefined);
    expect(detail.body.variants[0]).toMatchObject({ available: 0, inStock: false });
    const inStock = await call(ctx.app, 'GET', `/shop/${s.slug}/products?inStock=true`, undefined);
    expect(inStock.body.items.map((i: any) => i.slug)).toEqual(['ankara-wax']);

    // stock held at a location the storefront does not sell from is invisible
    await receive(ctx.app, s.a, s.w.w1, s.w.lotted.variantId, '30', { lotCode: 'L1' });
    await s.publish(s.w.lotted.productId, { slug: 'lotted', title: 'Lotted', published: true });
    const lotted = await call(ctx.app, 'GET', `/shop/${s.slug}/products/lotted`, undefined);
    expect(lotted.body.variants[0]).toMatchObject({ available: 0, inStock: false });

    await s.publish(s.w.lotted.productId, { published: false });
    expect((await call(ctx.app, 'GET', `/shop/${s.slug}/products/lotted`, undefined)).status).toBe(404);
  });

  it('searches, filters, sorts and pages', async () => {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    await s.publish(s.w.rolled.productId, { slug: 'cheap-roll', title: 'Cheap Roll Fabric', brand: 'Florance', published: true, sort: 5 });
    await s.publish(s.w.inclusive.productId, { slug: 'budget-lace', title: '100% Lace', published: true, sort: 1 });
    const get = async (qs: string) => (await call(ctx.app, 'GET', `/shop/${s.slug}/products?${qs}`, undefined)).body;
    expect((await get('')).total).toBe(3);
    expect((await get('q=lace')).items.map((i: any) => i.slug)).toEqual(['budget-lace']);
    // a literal percent sign is not a wildcard
    expect((await get(`q=${encodeURIComponent('%')}`)).items.map((i: any) => i.slug)).toEqual(['budget-lace']);
    expect((await get('q=florance')).items.map((i: any) => i.slug)).toEqual(['cheap-roll']);
    expect((await get('department=fabrics')).items.map((i: any) => i.slug)).toEqual(['ankara-wax']);
    expect((await get('sort=price_asc')).items.map((i: any) => i.slug)).toEqual(['budget-lace', 'cheap-roll', 'ankara-wax']);
    expect((await get('sort=price_desc')).items.map((i: any) => i.slug)).toEqual(['ankara-wax', 'cheap-roll', 'budget-lace']);
    expect((await get('minPrice=1000&maxPrice=2000')).items.map((i: any) => i.slug)).toEqual(['cheap-roll']);
    const page2 = await get('sort=price_asc&limit=2&page=2');
    expect(page2).toMatchObject({ total: 3, page: 2, limit: 2 });
    expect(page2.items.map((i: any) => i.slug)).toEqual(['ankara-wax']);
    expect((await call(ctx.app, 'GET', `/shop/${s.slug}/products?minPrice=9&maxPrice=1`, undefined)).status).toBe(422);
    expect((await call(ctx.app, 'GET', `/shop/${s.slug}/products?limit=1000`, undefined)).status).toBe(400);
  });

  it('serves public reads with cache headers and nothing from staff-only endpoints', async () => {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    const res = await ctx.app.inject({ method: 'GET', url: `/shop/${s.slug}/products` });
    expect(res.headers['cache-control']).toMatch(/public/);
    expect((await call(ctx.app, 'GET', '/v1/storefronts', undefined)).status).toBe(401);
  });
});

describe('delivery quotes', () => {
  it('picks the most specific zone and waives the fee above the free threshold', async () => {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    const zone = (body: Record<string, unknown>) => call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, body);
    expect((await zone({ name: 'Nigeria', countryCode: 'NG', feeMinor: 500000, freeOverMinor: 5000000, etaDaysMin: 3, etaDaysMax: 7 })).status).toBe(201);
    expect((await zone({ name: 'Kano', countryCode: 'NG', states: ['Kano', 'Kaduna'], feeMinor: 150000, etaDaysMin: 1, etaDaysMax: 2 })).status).toBe(201);
    const quote = (state: string, subtotalMinor: number, countryCode = 'ng') =>
      call(ctx.app, 'POST', `/shop/${s.slug}/delivery-quote`, undefined, { countryCode, state, subtotalMinor });
    expect((await quote('KANO', 100)).body).toMatchObject({ zone: 'Kano', feeMinor: 150000, etaDays: { min: 1, max: 2 } });
    expect((await quote('Lagos', 100)).body).toMatchObject({ zone: 'Nigeria', feeMinor: 500000, freeOverMinor: 5000000 });
    expect((await quote('Lagos', 5000000)).body).toMatchObject({ feeMinor: 0, standardFeeMinor: 500000 });
    expect((await quote('Accra', 100, 'GH')).status).toBe(422);
    const zones = await call(ctx.app, 'GET', `/v1/storefronts/${s.id}/delivery-zones`, s.a);
    const kano = zones.body.find((z: any) => z.name === 'Kano');
    const off = await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}/delivery-zones/${kano.id}`, s.a, { ...kano, active: false });
    expect(off.body.active).toBe(false);
    expect((await quote('Kano', 100)).body.zone).toBe('Nigeria');
    expect((await call(ctx.app, 'DELETE', `/v1/storefronts/${s.id}/delivery-zones/${kano.id}`, s.a)).status).toBe(204);
  });
});

describe('shoppers', () => {
  it('needs a sign-in, registers once, and is not staff', async () => {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    expect((await call(ctx.app, 'GET', `/shop/${s.slug}/me`, undefined)).status).toBe(401);
    const c = await shopper(`a-${uniq()}@example.test`);
    expect((await call(ctx.app, 'GET', `/shop/${s.slug}/me`, c.auth)).status).toBe(404);
    const reg = await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Amina Yusuf', phone: '+2348012345678', marketingOptIn: true });
    expect(reg.status).toBe(201);
    expect(reg.body).toMatchObject({ email: c.email, fullName: 'Amina Yusuf', marketingOptIn: true, status: 'active' });
    const again = await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Someone Else' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(reg.body.id);
    expect(again.body.fullName).toBe('Amina Yusuf');
    const upd = await call(ctx.app, 'PUT', `/shop/${s.slug}/me`, c.auth, { fullName: 'Amina Y. Yusuf' });
    expect(upd.body).toMatchObject({ fullName: 'Amina Y. Yusuf', phone: '+2348012345678', marketingOptIn: true });
    // a customer is not a staff user, and staff are not customers
    expect((await call(ctx.app, 'GET', '/v1/me', c.auth)).status).toBe(401);
    expect((await call(ctx.app, 'GET', `/shop/${s.slug}/me`, s.a)).status).toBe(404);
    // a token without an email cannot register
    const noMail = { authorization: `Bearer ${await token(`cust-${uniq()}`)}` };
    expect((await call(ctx.app, 'POST', `/shop/${s.slug}/me`, noMail, { fullName: 'No Email' })).status).toBe(422);
  });

  it('keeps customers of one organisation apart from another and refuses blocked accounts', async () => {
    const s1 = await shopWorld(ctx);
    const s2 = await shopWorld(ctx);
    await goLive(ctx, s1);
    await goLive(ctx, s2);
    const c = await shopper(`b-${uniq()}@example.test`);
    expect((await call(ctx.app, 'POST', `/shop/${s1.slug}/me`, c.auth, { fullName: 'Bala Musa' })).status).toBe(201);
    expect((await call(ctx.app, 'GET', `/shop/${s2.slug}/me`, c.auth)).status).toBe(404);
    // the same subject cannot also be registered with a second organisation
    expect((await call(ctx.app, 'POST', `/shop/${s2.slug}/me`, c.auth, { fullName: 'Bala Musa' })).status).toBe(409);
    await ctx.db.query(`UPDATE customers SET status = 'blocked' WHERE external_subject = $1`, [c.sub]);
    expect((await call(ctx.app, 'GET', `/shop/${s1.slug}/me`, c.auth)).status).toBe(403);
    expect((await call(ctx.app, 'GET', `/shop/${s1.slug}/me/addresses`, c.auth)).status).toBe(403);
  });

  it('manages addresses with exactly one default and a limit', async () => {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    const c = await shopper(`c-${uniq()}@example.test`);
    await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Chika Obi' });
    const addr = (label: string, extra: Record<string, unknown> = {}) =>
      call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label, recipient: 'Chika Obi', phone: '+2348011111111', line1: '12 Zoo Road', city: 'Kano', state: 'Kano', countryCode: 'ng', ...extra });
    const home = await addr('Home');
    expect(home.body).toMatchObject({ isDefault: true, countryCode: 'NG' });
    const shop = await addr('Shop');
    expect(shop.body.isDefault).toBe(false);
    const moved = await addr('Office', { isDefault: true });
    expect(moved.body.isDefault).toBe(true);
    let list = await call(ctx.app, 'GET', `/shop/${s.slug}/me/addresses`, c.auth);
    expect(list.body.filter((a: any) => a.isDefault)).toHaveLength(1);
    expect(list.body[0].label).toBe('Office');
    const edit = await call(ctx.app, 'PUT', `/shop/${s.slug}/me/addresses/${shop.body.id}`, c.auth, { label: 'Shop 2', recipient: 'Chika', phone: '+2348011111111', line1: '5 Kwari Market', city: 'Kano', state: 'Kano', countryCode: 'NG', isDefault: true });
    expect(edit.body).toMatchObject({ label: 'Shop 2', isDefault: true });
    list = await call(ctx.app, 'GET', `/shop/${s.slug}/me/addresses`, c.auth);
    expect(list.body.filter((a: any) => a.isDefault).map((a: any) => a.label)).toEqual(['Shop 2']);
    // deleting the default promotes another
    expect((await call(ctx.app, 'DELETE', `/shop/${s.slug}/me/addresses/${shop.body.id}`, c.auth)).status).toBe(204);
    list = await call(ctx.app, 'GET', `/shop/${s.slug}/me/addresses`, c.auth);
    expect(list.body.filter((a: any) => a.isDefault)).toHaveLength(1);
    // someone else's address is not reachable
    const d = await shopper(`d-${uniq()}@example.test`);
    await call(ctx.app, 'POST', `/shop/${s.slug}/me`, d.auth, { fullName: 'Dayo Ade' });
    expect((await call(ctx.app, 'DELETE', `/shop/${s.slug}/me/addresses/${home.body.id}`, d.auth)).status).toBe(404);
    for (let i = 0; i < 8; i++) expect((await addr(`Extra ${i}`)).status).toBe(201);
    expect((await addr('One too many')).status).toBe(409);
  });

  it('keeps a wishlist of published products with live prices', async () => {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    const c = await shopper(`e-${uniq()}@example.test`);
    await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Efe Okoro' });
    const put = await call(ctx.app, 'PUT', `/shop/${s.slug}/me/wishlist/ankara-wax`, c.auth);
    expect(put.status).toBe(204);
    expect((await call(ctx.app, 'PUT', `/shop/${s.slug}/me/wishlist/ankara-wax`, c.auth)).status).toBe(204);
    expect((await call(ctx.app, 'PUT', `/shop/${s.slug}/me/wishlist/nothing-here`, c.auth)).status).toBe(404);
    const list = await call(ctx.app, 'GET', `/shop/${s.slug}/me/wishlist`, c.auth);
    expect(list.body).toEqual([expect.objectContaining({ slug: 'ankara-wax', priceMinor: 376304 })]);
    await s.publish(s.w.fabric.productId, { published: false });
    expect((await call(ctx.app, 'GET', `/shop/${s.slug}/me/wishlist`, c.auth)).body).toEqual([]);
    await s.publish(s.w.fabric.productId, { published: true });
    expect((await call(ctx.app, 'DELETE', `/shop/${s.slug}/me/wishlist/ankara-wax`, c.auth)).status).toBe(204);
    expect((await call(ctx.app, 'GET', `/shop/${s.slug}/me/wishlist`, c.auth)).body).toEqual([]);
  });
});
