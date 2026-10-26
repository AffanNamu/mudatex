import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../errors.js';
import type { Db } from '../db.js';
import { DEPARTMENTS, PRODUCTS } from '../demo/sample.js';

/**
 * Fills an empty system with a sample company, catalogue, prices, stock, a till and a live online store, so the whole
 * thing can be seen working. It only runs on a system with no companies and no products, and it works through the same
 * public endpoints a person would use, with the caller's own permissions, so it cannot do anything they could not.
 */
export const demoRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/demo/seed', async (req, reply) => {
    const orgId = req.actor.organizationId;
    const used = await db.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM legal_entities WHERE organization_id = $1) + (SELECT count(*) FROM products WHERE organization_id = $1) AS n`,
      [orgId],
    );
    if (Number(used.rows[0]!.n) > 0) throw new AppError(409, 'conflict', 'Sample data can only be loaded into a system that has no companies or products yet');

    // The web name is unique across the whole system; the first system gets the plain name.
    const taken = await db.query(`SELECT 1 FROM storefronts WHERE slug = 'demo'`);
    const slug = taken.rowCount ? `demo-${crypto.randomUUID().slice(0, 4)}` : 'demo';
    const authorization = req.headers.authorization!;
    const call = async <T = any>(method: 'POST' | 'PUT', url: string, payload: unknown, step: string): Promise<T> => {
      const res = await app.inject({ method, url: `/v1${url}`, headers: { authorization, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, payload: payload as never });
      const body = res.body ? JSON.parse(res.body) : undefined;
      if (res.statusCode >= 400) throw new AppError(res.statusCode === 403 ? 403 : 422, body?.error ?? 'invalid', `Could not ${step}: ${body?.message ?? res.statusCode}`);
      return body as T;
    };

    const le = await call('POST', '/legal-entities', { name: 'Mudatex Demo Textiles Ltd', countryCode: 'NG', functionalCurrency: 'NGN' }, 'create the company');
    const place = (type: string, name: string) => call('POST', '/locations', { legalEntityId: le.id, type, name, countryCode: 'NG', timezone: 'Africa/Lagos' }, `create ${name}`);
    const warehouse = await place('warehouse', 'Kano Warehouse');
    const shop = await place('branch', 'Kwari Market Shop');
    const unit = (code: string, name: string, kind: string, precision: number) => call('POST', '/units', { code, name, kind, precision }, `create the unit ${code}`);
    const metre = await unit('m', 'Metre', 'decimal', 2);
    const roll = await unit('roll', 'Roll', 'discrete', 0);
    const vat = await call('POST', '/pricing/tax-codes', { legalEntityId: le.id, code: 'VAT75', name: 'VAT 7.5%', rate: '0.075', priceInclusive: false }, 'create the tax code');
    const retail = await call('POST', '/pricing/price-lists', { legalEntityId: le.id, name: 'Retail NGN', currency: 'NGN' }, 'create the retail price list');
    const wholesale = await call('POST', '/pricing/price-lists', { legalEntityId: le.id, name: 'Wholesale NGN', currency: 'NGN' }, 'create the wholesale price list');
    await call('POST', '/pos/registers', { locationId: shop.id, code: 'KWARI1', name: 'Front till', priceListId: retail.id, maxDiscountBps: 500, refundThresholdMinor: 5_000_000 }, 'create the till');

    const published: { productId: string; p: (typeof PRODUCTS)[number] }[] = [];
    const warehouseLines: { variantId: string; quantity: string }[] = [];
    const shopLines: { variantId: string; quantity: string }[] = [];
    for (const p of PRODUCTS) {
      const created = await call('POST', '/products', {
        name: p.name, description: p.description, category: DEPARTMENTS.find((d) => d.slug === p.department)!.name, baseUnitId: metre.id, variants: [{ sku: p.sku }],
        conversions: p.roll ? [{ fromUnitId: roll.id, toUnitId: metre.id, factor: '50' }] : [],
      }, `create ${p.name}`);
      const variantId = created.variantIds[0] as string;
      await call('PUT', `/pricing/price-lists/${retail.id}/items`, { variantId, unitPrice: p.price, taxCodeId: vat.id }, `price ${p.name}`);
      await call('PUT', `/pricing/price-lists/${wholesale.id}/items`, { variantId, unitPrice: p.wholesale, taxCodeId: vat.id }, `price ${p.name} for wholesale`);
      if (p.stock !== '0') {
        // most of the stock sits in the warehouse; the shop keeps a little on hand for the till
        const shopQty = Math.min(30, Number(p.stock) / 10);
        warehouseLines.push({ variantId, quantity: String(Number(p.stock) - shopQty) });
        shopLines.push({ variantId, quantity: String(shopQty) });
      }
      published.push({ productId: created.id, p });
    }

    await call('POST', '/inventory/receipts', { locationId: warehouse.id, reference: 'Opening stock (sample)', lines: warehouseLines }, 'receive the warehouse stock');
    await call('POST', '/inventory/receipts', { locationId: shop.id, reference: 'Opening stock (sample)', lines: shopLines }, 'receive the shop stock');

    const store = await call('POST', '/storefronts', {
      legalEntityId: le.id, slug, name: 'Mudatex Demo Store', priceListId: retail.id, stockLocationIds: [warehouse.id],
      tagline: 'Free delivery over ₦100,000 — sample store',
      contact: { whatsapp: '+2348000000000', phone: '+234 800 000 0000', email: 'hello@example.com', address: 'Kwari Market, Kano (sample address)', bankName: 'Sample Bank', accountName: 'Mudatex Demo Textiles Ltd', accountNumber: '0000000000' },
    }, 'create the online store');
    const depts: Record<string, string> = {};
    for (const [i, d] of DEPARTMENTS.entries()) depts[d.slug] = (await call('POST', `/storefronts/${store.id}/departments`, { slug: d.slug, name: d.name, sort: i * 10 }, `add the department ${d.name}`)).id;
    for (const { productId, p } of published) {
      await call('PUT', `/storefronts/${store.id}/products/${productId}`, {
        title: p.name, brand: p.brand, departmentId: depts[p.department], description: p.description, badges: p.badge ? [p.badge] : [], published: true,
      }, `publish ${p.name}`);
    }
    await call('POST', `/storefronts/${store.id}/delivery-zones`, { name: 'Kano', countryCode: 'NG', states: ['Kano'], feeMinor: 150000, freeOverMinor: 10_000_000, etaDaysMin: 1, etaDaysMax: 2 }, 'add delivery for Kano');
    await call('POST', `/storefronts/${store.id}/delivery-zones`, { name: 'Rest of Nigeria', countryCode: 'NG', feeMinor: 450000, freeOverMinor: 10_000_000, etaDaysMin: 3, etaDaysMax: 6 }, 'add delivery for Nigeria');
    await call('POST', `/storefronts/${store.id}/coupons`, { code: 'WELCOME10', description: 'Welcome offer', percentBps: 1000, perCustomerLimit: 1 }, 'add the welcome coupon');
    await call('PUT', `/storefronts/${store.id}`, { status: 'live' }, 'open the store');

    return reply.status(201).send({ company: le.name, storefront: slug, products: PRODUCTS.length, locations: 2, note: `Sample data loaded. Use the store web name "${slug}" as NEXT_PUBLIC_SHOP_SLUG.` });
  });
};
