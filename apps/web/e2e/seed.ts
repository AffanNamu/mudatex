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
  bookkeeper: 'bookkeeper@e2e.test',
  accountant: 'accountant@e2e.test',
  controller: 'controller@e2e.test',
  rateEntry: 'rates@e2e.test',
  rateApprover: 'rates-approver@e2e.test',
  bomMaker: 'bom-maker@e2e.test',
  bomApprover: 'bom-approver@e2e.test',
  planner: 'planner@e2e.test',
  storeman: 'storeman@e2e.test',
  operator: 'operator@e2e.test',
  supervisor2: 'production-lead@e2e.test',
  inspector: 'inspector@e2e.test',
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

  // Production: separate materials, so the till and stock tests are not disturbed.
  const pieces = await post('/v1/units', { code: 'pcs', name: 'Pieces', kind: 'discrete', precision: 0 });
  const stocked = async (name: string, sku: string, unitId: string, qty: string) => {
    const p = await post('/v1/products', { name, baseUnitId: unitId, variants: [{ sku }] });
    await post('/v1/inventory/receipts', { locationId: shop.id, lines: [{ variantId: p.variantIds[0], quantity: qty }] });
  };
  await stocked('Calico', 'CAL-001', metre.id, '500');
  await stocked('Button', 'BTN-001', pieces.id, '2000');
  await post('/v1/products', { name: 'Shirt', baseUnitId: pieces.id, variants: [{ sku: 'SHT-001', tracking: 'lot' }] });
  await post('/v1/manufacturing/work-centres', { locationId: shop.id, code: 'CUT', name: 'Cutting table' });
  await post('/v1/manufacturing/work-centres', { locationId: shop.id, code: 'SEW', name: 'Sewing line' });

  // A small set of books for the accounting tests (the real chart of accounts is a finance decision).
  const account = (code: string, name: string, type: string) => post('/v1/accounting/accounts', { legalEntityId: le.id, code, name, type });
  await account('1000', 'Cash', 'asset');
  await account('3000', 'Capital', 'equity');
  await account('4000', 'Sales', 'revenue');
  await account('5000', 'Rent', 'expense');
  await post('/v1/accounting/periods', { legalEntityId: le.id, name: 'Old 2019', startDate: '2019-01-01', endDate: '2019-12-31' });
  await post('/v1/accounting/periods', { legalEntityId: le.id, name: 'Open years', startDate: '2020-01-01', endDate: '2099-12-31' });

  await post('/v1/pos/registers', { locationId: shop.id, code: 'LAG1', name: 'Front till', priceListId: list.id, maxDiscountBps: 1000, refundThresholdMinor: 200000 });

  const staff = async (email: string, name: string, permissions: string[], scope: Record<string, string> = { type: 'location', id: shop.id }) => {
    const u = await post('/v1/users', { externalSubject: email, email, displayName: name });
    const r = await post('/v1/roles', { key: `e2e_${name.toLowerCase().replace(/\W/g, '_')}`, name, permissions });
    await post('/v1/memberships', { userId: u.id, roleId: r.id, scope });
  };
  const company = { type: 'legal_entity', id: le.id };
  await staff(USERS.cashier, 'Cashier Chi', ['pos.sell', 'pos.session', 'pos.discount', 'pos.refund', 'pos.read', 'inventory.read']);
  await staff(USERS.supervisor, 'Supervisor Sade', ['pos.sell', 'pos.session', 'pos.discount', 'pos.discount.override', 'pos.payment.verify', 'pos.read', 'inventory.read']);
  await staff(USERS.buyer, 'Buyer Bola', ['procurement.create', 'procurement.approve', 'procurement.read', 'catalog.read']);
  await staff(USERS.approver, 'Approver Amaka', ['procurement.approve', 'procurement.read']);
  await staff(USERS.receiver, 'Receiver Rilwan', ['procurement.receive', 'procurement.read', 'inventory.read']);
  await staff(USERS.bookkeeper, 'Bookkeeper Bisi', ['accounting.journal', 'accounting.read'], company);
  await staff(USERS.accountant, 'Accountant Ade', ['accounting.post', 'accounting.read'], company);
  await staff(USERS.controller, 'Controller Chike', ['accounting.period.close', 'accounting.period.reopen', 'accounting.read'], company);
  await staff(USERS.rateEntry, 'Rates Ruth', ['accounting.rates.manage', 'accounting.read'], { type: 'group' });
  await staff(USERS.rateApprover, 'Rates Approver Ola', ['accounting.rates.approve', 'accounting.read'], { type: 'group' });
  const here = { type: 'location', id: shop.id };
  await staff(USERS.bomMaker, 'BOM Maker Mide', ['manufacturing.bom.manage', 'manufacturing.read', 'catalog.read'], { type: 'group' });
  await staff(USERS.bomApprover, 'BOM Approver Aisha', ['manufacturing.bom.approve', 'manufacturing.read'], { type: 'group' });
  await staff(USERS.planner, 'Planner Paul', ['manufacturing.plan', 'manufacturing.read', 'inventory.read'], here);
  await staff(USERS.storeman, 'Storeman Sule', ['manufacturing.issue', 'manufacturing.read'], here);
  await staff(USERS.operator, 'Operator Obi', ['manufacturing.operate', 'manufacturing.read'], here);
  await staff(USERS.supervisor2, 'Production Lead Lola', ['manufacturing.close', 'manufacturing.issue', 'manufacturing.read'], here);
  await staff(USERS.inspector, 'Inspector Ife', ['quality.hold', 'quality.release', 'manufacturing.read'], here);
  await staff(USERS.clerk, 'Clerk Kemi', ['catalog.read', 'inventory.read', 'inventory.receive']);
}
