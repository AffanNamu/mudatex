export const SLUG = 'e2e-shop';

export async function seedShop(API) {
  const call = async (token, method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': crypto.randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  const a = (await call(null, 'POST', '/v1/dev/token', { email: 'admin@e2e.test' })).token;
  const post = (path, body) => call(a, 'POST', path, body);

  const le = await post('/v1/legal-entities', { name: 'E2E Textiles Ltd', countryCode: 'NG', functionalCurrency: 'NGN' });
  const warehouse = await post('/v1/locations', { legalEntityId: le.id, type: 'warehouse', name: 'Kano Warehouse', countryCode: 'NG', timezone: 'Africa/Lagos' });
  const metre = await post('/v1/units', { code: 'm', name: 'Metre', kind: 'decimal', precision: 2 });
  const roll = await post('/v1/units', { code: 'roll', name: 'Roll', kind: 'discrete', precision: 0 });
  const tax = await post('/v1/pricing/tax-codes', { legalEntityId: le.id, code: 'VAT75', name: 'VAT 7.5%', rate: '0.075', priceInclusive: false });
  const list = await post('/v1/pricing/price-lists', { legalEntityId: le.id, name: 'Online NGN', currency: 'NGN' });

  const wholesale = await post('/v1/pricing/price-lists', { legalEntityId: le.id, name: 'Wholesale NGN', currency: 'NGN' });
  const variants = {};
  const product = async (name, sku, price, stock, conversions = []) => {
    const p = await post('/v1/products', { name, baseUnitId: metre.id, variants: [{ sku }], conversions });
    const variantId = p.variantIds[0];
    await call(a, 'PUT', `/v1/pricing/price-lists/${list.id}/items`, { variantId, unitPrice: price, taxCodeId: tax.id });
    if (sku === 'ATP-001') await call(a, 'PUT', `/v1/pricing/price-lists/${wholesale.id}/items`, { variantId, unitPrice: '1500', taxCodeId: tax.id });
    if (stock !== '0') await post('/v1/inventory/receipts', { locationId: warehouse.id, lines: [{ variantId, quantity: stock }] });
    variants[sku] = { productId: p.id, variantId };
  };
  await product('Ankara Wax Print', 'ANK-001', '1000', '50', [{ fromUnitId: roll.id, toUnitId: metre.id, factor: '50' }]);
  await product('Swiss Lace', 'LCE-001', '2500', '3');
  await product('Brocade Gold', 'BRC-001', '4000', '0');
  await product('Atampa Blue', 'ATP-001', '1800', '120');

  const sf = await post('/v1/storefronts', {
    legalEntityId: le.id, slug: SLUG, name: 'E2E Textiles', priceListId: list.id, stockLocationIds: [warehouse.id],
    tagline: 'Free delivery over ₦100,000',
    siteUrl: 'http://localhost:3300',
    contact: { whatsapp: '+2348012345678', phone: '+234 801 234 5678', email: 'hello@e2e.test', bankName: 'Test Bank', accountName: 'E2E Textiles Ltd', accountNumber: '0123456789' },
  });
  const dept = async (name, slug) => (await post(`/v1/storefronts/${sf.id}/departments`, { slug, name })).id;
  const ankara = await dept('Ankara', 'ankara');
  const lace = await dept('Lace', 'lace');
  const publish = (sku, body) => call(a, 'PUT', `/v1/storefronts/${sf.id}/products/${variants[sku].productId}`, { published: true, ...body });
  await publish('ANK-001', { slug: 'ankara-wax-print', title: 'Ankara Wax Print', brand: 'Empire Atampa', departmentId: ankara, badges: ['New'], description: 'Bold, colour-fast wax print.' });
  await publish('LCE-001', { slug: 'swiss-lace', title: 'Swiss Lace', brand: 'Florance', departmentId: lace });
  await publish('BRC-001', { slug: 'brocade-gold', title: 'Brocade Gold', departmentId: lace });
  await publish('ATP-001', { slug: 'atampa-blue', title: 'Atampa Blue', brand: 'Empire Atampa', departmentId: ankara });
  await post(`/v1/storefronts/${sf.id}/delivery-zones`, { name: 'Kano', countryCode: 'NG', states: ['Kano'], feeMinor: 150000, freeOverMinor: 10000000, etaDaysMin: 1, etaDaysMax: 2 });
  await post(`/v1/storefronts/${sf.id}/delivery-zones`, { name: 'Nigeria', countryCode: 'NG', feeMinor: 450000, etaDaysMin: 3, etaDaysMax: 6 });
  await post(`/v1/storefronts/${sf.id}/coupons`, { code: 'WELCOME10', description: 'Welcome offer', percentBps: 1000, perCustomerLimit: 1 });
  await call(a, 'PUT', `/v1/storefronts/${sf.id}`, { status: 'live' });
  return { wholesaleListId: wholesale.id, adminToken: a, storefrontId: sf.id, variants };
}
