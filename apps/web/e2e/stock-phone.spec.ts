import { expect, test, type Page } from '@playwright/test';
import { noA11yViolations, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 390, height: 844 } });

const API = 'http://localhost:3100';
async function token(email: string) {
  const r = await fetch(`${API}/v1/dev/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  return ((await r.json()) as { token: string }).token;
}
async function api<T = any>(email: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await token(email)}`, 'idempotency-key': crypto.randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}
const shopId = async () => (await api<{ id: string; name: string }[]>('admin@e2e.test', 'GET', '/v1/locations')).find((l) => l.name === 'Lagos Shop')!.id;
const onShelf = async (sku: string) => {
  const loc = await shopId();
  const [item] = await api<any[]>('admin@e2e.test', 'GET', `/v1/inventory/lookup?locationId=${loc}&code=${sku}`);
  return { variantId: item.variantId as string, quantity: item.balances.reduce((n: number, b: any) => n + Number(b.quantity), 0) };
};
const scan = async (page: Page, code: string) => {
  await page.getByLabel('Scan or type a barcode / SKU').fill(code);
  await page.getByRole('button', { name: 'Find' }).click();
};
const openStock = async (page: Page, email: string, tab: string) => {
  await signIn(page, email);
  await page.goto(`/stock?tab=${tab}`);
  await expect(page.getByText(/Stock list from/)).toBeVisible();
};

test('a stock hand counts the shelf; differences wait for a second person, and nothing moves until then', async ({ page }) => {
  await openStock(page, 'stockhand@e2e.test', 'count');
  await expect(page.getByRole('tab', { name: 'Count' })).toHaveAttribute('aria-selected', 'true');

  await scan(page, '5012345678900');               // barcode scan adds one…
  await scan(page, '5012345678900');               // …and each further scan adds another
  const zip = page.getByLabel(/Counted Brass Zip/);
  await expect(zip).toHaveValue('2');
  await zip.fill('37');
  await scan(page, 'lin-001');                     // a lot-tracked cloth gives one row per lot on the shelf
  await expect(page.getByText('lot LOT-A')).toBeVisible();
  await page.getByLabel(/Counted Linen Bolt/).fill('25');
  await page.getByLabel('Note (optional)').fill('End of day');
  await noA11yViolations(page);

  await page.getByRole('button', { name: 'Send count (2)' }).click();
  await expect(page.getByText('Count sent.')).toBeVisible();
  await expect(page.getByText('1 matched the books.')).toBeVisible();
  await expect(page.getByText(/Brass Zip: counted 37, books said 40 \(-3\)/)).toBeVisible();
  expect((await onShelf('ZIP-001')).quantity).toBe(40);   // not changed yet

  const counts = await api<any[]>('stockboss@e2e.test', 'GET', `/v1/inventory/counts?locationId=${await shopId()}`);
  expect(counts[0]).toMatchObject({ adjustmentStatus: 'pending', note: 'End of day', lines: 2 });
  await api('stockboss@e2e.test', 'POST', `/v1/inventory/adjustments/${counts[0].adjustmentId}/approve`, {});
  expect((await onShelf('ZIP-001')).quantity).toBe(37);
});

test('a count taken without a signal is kept on the phone and sent when the signal returns', async ({ page, context }) => {
  await openStock(page, 'stockhand@e2e.test', 'count');
  await context.setOffline(true);
  await expect(page.getByText(/No connection/).first()).toBeVisible();
  await scan(page, 'ZIP-001');
  await page.getByLabel(/Counted Brass Zip/).fill('36');
  await page.getByRole('button', { name: 'Send count (1)' }).click();
  await expect(page.getByText(/Saved on this phone/)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Waiting (1)' })).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText('Count sent.')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Waiting' })).toBeVisible();
  await page.getByRole('tab', { name: 'Waiting' }).click();
  await expect(page.getByText('Nothing is waiting.')).toBeVisible();
  const counts = await api<any[]>('stockboss@e2e.test', 'GET', `/v1/inventory/counts?locationId=${await shopId()}`);
  expect(counts[0]).toMatchObject({ adjustmentStatus: 'pending', lines: 1 });
});

test('a count in progress is still there after the page is reloaded', async ({ page }) => {
  await openStock(page, 'stockhand@e2e.test', 'count');
  await scan(page, 'ZIP-001');
  await page.getByLabel(/Counted Brass Zip/).fill('12');
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.getByLabel(/Counted Brass Zip/)).toHaveValue('12');
  await page.getByRole('button', { name: 'Remove Brass Zip' }).click();
});

test('goods are received against an order by scanning, and a lot code is required for lot-tracked cloth', async ({ page }) => {
  const loc = await shopId();
  const sup = (await api<any[]>('admin@e2e.test', 'GET', '/v1/procurement/suppliers')).find((s) => s.code === 'MILL-1');
  const zip = await onShelf('ZIP-001');
  const linen = await onShelf('LIN-001');
  const po = await api('admin@e2e.test', 'POST', '/v1/procurement/purchase-orders', {
    supplierId: sup.id, destinationLocationId: loc, currency: 'USD',
    lines: [{ variantId: zip.variantId, quantity: '100', unitPrice: '0.5' }, { variantId: linen.variantId, quantity: '30', unitPrice: '4' }],
  });
  await api('admin@e2e.test', 'POST', `/v1/procurement/purchase-orders/${po.id}/submit`, {});
  await api('buyer@e2e.test', 'POST', `/v1/procurement/purchase-orders/${po.id}/approve`, {});

  await openStock(page, 'stockhand@e2e.test', 'receive');
  await page.getByRole('button', { name: new RegExp(po.poNumber) }).click();
  await scan(page, '5012345678900');
  await scan(page, '5012345678900');
  await scan(page, '5012345678900');
  await expect(page.getByLabel('Received Brass Zip')).toHaveValue('3');
  await page.getByLabel('Received Linen Bolt').fill('10');
  await expect(page.getByText('Enter the lot code')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record receipt (2)' })).toBeDisabled();
  await page.getByLabel('Lot code for Linen Bolt').fill('LOT-B');
  await page.getByLabel('Delivery note number (optional)').fill('DN-7781');
  await noA11yViolations(page);
  await page.getByRole('button', { name: 'Record receipt (2)' }).click();
  await expect(page.getByText('Received and added to stock.')).toBeVisible();

  expect((await onShelf('ZIP-001')).quantity).toBe(zip.quantity + 3);
  expect((await onShelf('LIN-001')).quantity).toBe(linen.quantity + 10);
  const after = await api('admin@e2e.test', 'GET', `/v1/procurement/purchase-orders/${po.id}`);
  expect(after.status).toBe('partially_received');
  expect(after.receipts[0].deliveryNote).toBe('DN-7781');
});

test('stock can also be received without an order, and looked up afterwards', async ({ page }) => {
  const before = await onShelf('ZIP-001');
  await openStock(page, 'stockhand@e2e.test', 'receive');
  await page.getByRole('button', { name: 'Without an order' }).click();
  await scan(page, 'ZIP-001');
  await page.getByLabel('Quantity of Brass Zip').fill('5');
  await page.getByRole('button', { name: 'Add to stock (1)' }).click();
  await expect(page.getByText('Received and added to stock.')).toBeVisible();
  expect((await onShelf('ZIP-001')).quantity).toBe(before.quantity + 5);

  await page.getByRole('tab', { name: 'Look up' }).click();
  await expect(page.getByRole('tab', { name: 'Look up' })).toHaveAttribute('aria-selected', 'true');
  await scan(page, '5012345678900');
  const card = page.getByRole('article', { name: 'Brass Zip' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('cell', { name: String(before.quantity + 5) }).first()).toBeVisible();
  await expect(page.getByText('From the copy on this phone')).toHaveCount(0);
});

test('the stock page fits a phone screen, and people without count or receive rights see only look-up', async ({ page }) => {
  await openStock(page, 'cashier@e2e.test', 'count');
  await expect(page.getByRole('tab', { name: 'Count' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Receive' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Look up' })).toHaveAttribute('aria-selected', 'true');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
