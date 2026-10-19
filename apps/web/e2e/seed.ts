/** Creates the shop floor the tests work in, through the public API exactly as an administrator would. */
const API = process.env.E2E_API_URL ?? 'http://localhost:3100';

async function call<T = any>(token: string | null, method: string, path: string, body?: unknown, key?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'idempotency-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return data;
}

export const USERS = {
  admin: 'admin@e2e.test',
  cashier: 'cashier@e2e.test',
  clerk: 'clerk@e2e.test',
  buyer: 'buyer@e2e.test',
  approver: 'approver@e2e.test',
  receiver: 'receiver@e2e.test',
  supervisor: 'supervisor@e2e.test',
} as const;

export default async function seed() {
  const login = async (email: string) => (await call(null, 'POST', '/v1/dev/token', { email })).token as string;
  const a = await login(USERS.admin);
  const post = (path: string, body: unknown, key?: string) => call(a, 'POST', path, body, key ?? crypto.randomUUID());

  const le = await post('/v1/legal-entities', { name: 'E2E Nigeria Ltd', countryCode: 'NG', functionalCurrency: 'NGN' });
  const shop = await post('/v1/locations', { legalEntityId: le.id, type: 'branch', name: 'Lagos Shop', countryCode: 'NG', timezone: 'Africa/Lagos' });
  const metre = await post('/v1/units', { code: 'm', name: 'Metre', kind: 'decimal', precision: 2 });
  const tax = await post('/v1/pricing/tax-codes', { legalEntityId: le.id, code: 'VAT75', name: 'VAT 7.5%', rate: '0.075', priceInclusive: false });
  const list = await post('/v1/pricing/price-lists', { legalEntityId: le.id, name: 'Retail NGN', currency: 'NGN' });

  const product = async (name: string, sku: string, price: string, stock: string) => {
    const p = await post('/v1/products', { name, baseUnitId: metre.id, variants: [{ sku }] });
    const variantId = p.variantIds[0] as string;
    await call(a, 'PUT', `/v1/pricing/price-lists/${list.id}/items`, { variantId, unitPrice: price, taxCodeId: tax.id });
    await post('/v1/inventory/receipts', { locationId: shop.id, lines: [{ variantId, quantity: stock }] });
    return variantId;
  };
  await product('Ankara Wax Print', 'ANK-001', '1000', '50');
  await product('Lace Fabric', 'LCE-001', '2500', '3');
  // Bought in rolls: nothing is stocked yet, so the purchasing tests can receive the first one.
  await post('/v1/products', { name: 'Silk Roll', baseUnitId: metre.id, variants: [{ sku: 'SLK-R1', tracking: 'roll' }] });
  await post('/v1/procurement/suppliers', { code: 'MILL-1', name: 'Kano Textile Mills', countryCode: 'NG', defaultCurrency: 'USD', paymentTermsDays: 30 });

  await post('/v1/pos/registers', { locationId: shop.id, code: 'LAG1', name: 'Front till', priceListId: list.id, maxDiscountBps: 1000, refundThresholdMinor: 200000 });

  const staff = async (email: string, name: string, permissions: string[]) => {
    const u = await post('/v1/users', { externalSubject: email, email, displayName: name });
    const r = await post('/v1/roles', { key: `e2e_${name.toLowerCase().replace(/\W/g, '_')}`, name, permissions });
    await post('/v1/memberships', { userId: u.id, roleId: r.id, scope: { type: 'location', id: shop.id } });
  };
  await staff(USERS.cashier, 'Cashier Chi', ['pos.sell', 'pos.session', 'pos.discount', 'pos.refund', 'pos.read', 'inventory.read']);
  await staff(USERS.supervisor, 'Supervisor Sade', ['pos.sell', 'pos.session', 'pos.discount', 'pos.discount.override', 'pos.payment.verify', 'pos.read', 'inventory.read']);
  await staff(USERS.buyer, 'Buyer Bola', ['procurement.create', 'procurement.approve', 'procurement.read', 'catalog.read']);
  await staff(USERS.approver, 'Approver Amaka', ['procurement.approve', 'procurement.read']);
  await staff(USERS.receiver, 'Receiver Rilwan', ['procurement.receive', 'procurement.read', 'inventory.read']);
  await staff(USERS.clerk, 'Clerk Kemi', ['catalog.read', 'inventory.read', 'inventory.receive']);
}
