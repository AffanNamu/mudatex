import { expect, test, type Page } from '@playwright/test';
import { noA11yViolations, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'allow' });

const API = 'http://localhost:3100';
const addAnkara = (page: Page) => page.getByRole('button', { name: /^Ankara Wax Print/ }).click();

async function adminGet(path: string) {
  const tok = (await (await fetch(`${API}/v1/dev/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@e2e.test' }) })).json()).token;
  return (await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${tok}` } })).json();
}

test('a till keeps selling cash with no connection, then sends the sales and gets official receipt numbers', async ({ page, context }) => {
  await signIn(page, 'offline-cashier@e2e.test');
  await page.getByRole('link', { name: 'Point of sale' }).click();
  await page.getByLabel('Register').selectOption({ label: 'LAG2 — Back till' });
  await page.getByLabel(/Opening float/).fill('50.00');
  await page.getByRole('button', { name: 'Open session' }).click();
  await expect(page.getByRole('region', { name: 'Cart' })).toBeVisible();
  // the till downloads its offline price list while the line is up, and the app files are kept for a reload
  await expect(page.getByText(/Offline selling is ready/)).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(500);

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText(/Working offline/)).toBeVisible();
  await noA11yViolations(page);

  // sale 1: priced on the till from the saved list, cash only
  await addAnkara(page);
  await page.getByLabel('Quantity of Ankara Wax Print').fill('2');
  await expect(page.getByTestId('total')).toHaveText('₦2,150.00');
  await expect(page.getByRole('radio', { name: 'Card' })).toBeDisabled();
  await page.getByLabel(/Cash tendered/).fill('2500');
  await page.getByRole('button', { name: /Take cash ₦2,150.00 \(offline\)/ }).click();
  await expect(page.getByRole('heading', { name: /Receipt OFF-/ })).toBeVisible();
  await expect(page.getByText(/Offline sale\. This number is provisional/)).toBeVisible();
  await page.getByRole('button', { name: 'New sale' }).click();

  // a reload while still offline: the app and the till's saved list come back from the device
  await page.reload();
  await expect(page.getByText(/Working from this till's saved price list|Working offline/).first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Cart' })).toBeVisible();
  await addAnkara(page);
  await expect(page.getByTestId('total')).toHaveText('₦1,075.00');
  await page.getByRole('button', { name: /Take cash/ }).click();
  await expect(page.getByRole('heading', { name: /Receipt OFF-/ })).toBeVisible();
  await page.getByRole('button', { name: 'New sale' }).click();
  await expect(page.getByText(/2 sale\(s\) waiting to be sent/)).toBeVisible();

  // the session cannot be closed with sales waiting
  await page.getByRole('button', { name: 'Close session' }).click();
  await expect(page.getByText(/Send the waiting sales before closing/)).toBeVisible();
  await page.getByRole('button', { name: 'Back to till' }).click();

  // the line returns: the sales are sent on their own
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText(/2 offline sale\(s\) sent and numbered/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/waiting to be sent/)).toHaveCount(0);

  const sales = await adminGet('/v1/pos/sales?limit=50');
  const mine = sales.filter((s: any) => s.receiptNumber.startsWith('LAG2-'));
  expect(mine.map((s: any) => [s.receiptNumber, s.totalMinor, s.status]).sort()).toEqual([['LAG2-000001', 215000, 'completed'], ['LAG2-000002', 107500, 'completed']]);

  // now it can close, and the drawer expects the cash from both sales
  await page.getByRole('button', { name: 'Close session' }).click();
  await page.getByLabel(/Counted cash/).fill('372.50'); // 50.00 float + 2,150.00 + 1,075.00 = 3,275.00 expected; 372.50 is deliberately short
  await page.getByRole('button', { name: 'Close session' }).last().click();
  await expect(page.getByRole('heading', { name: 'Session closed' })).toBeVisible();
  await expect(page.getByText('₦3,275.00')).toBeVisible();
});

test('an expired offline list is never used after a reload without a connection', async ({ page, context }) => {
  await signIn(page, 'offline-cashier@e2e.test');
  await page.getByRole('link', { name: 'Point of sale' }).click();
  await page.getByLabel('Register').selectOption({ label: 'LAG2 — Back till' });
  await page.getByLabel(/Opening float/).fill('10.00');
  await page.getByRole('button', { name: 'Open session' }).click();
  await expect(page.getByText(/Offline selling is ready/)).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(500);

  // age the saved list by two days
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open('mudatex-till'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const tx = db.transaction('packs', 'readwrite');
    const store = tx.objectStore('packs');
    const all = await new Promise<any[]>((res) => { const g = store.getAll(); g.onsuccess = () => res(g.result); });
    for (const p of all) { p.generatedAt = new Date(Date.now() - 48 * 3_600_000).toISOString(); store.put(p); }
    await new Promise((res) => { tx.oncomplete = () => res(null); });
    db.close();
  });
  await context.setOffline(true);
  await page.reload();
  // no till is offered from an out-of-date list
  await expect(page.getByRole('alert')).toContainText(/Cannot reach the server/);
  await expect(page.getByRole('region', { name: 'Cart' })).toHaveCount(0);

  await context.setOffline(false);
  await page.reload();
  await page.getByLabel('Register').selectOption({ label: 'LAG2 — Back till' });
  await expect(page.getByRole('region', { name: 'Cart' })).toBeVisible();
  await expect(page.getByText(/Offline selling is ready/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Close session' }).click();
  await page.getByLabel(/Counted cash/).fill('10.00');
  await page.getByRole('button', { name: 'Close session' }).last().click();
  await expect(page.getByRole('heading', { name: 'Session closed' })).toBeVisible();
});

test('a shortfall from an offline sale lands in the stock controller\'s list and is explained', async ({ page }) => {
  // an offline sale for more Lace than the books hold, sent straight to the server as a till would
  const tok = async (email: string) => (await (await fetch(`${API}/v1/dev/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).json()).token;
  const cashier = await tok('offline-cashier@e2e.test');
  const h = { 'content-type': 'application/json', authorization: `Bearer ${cashier}` };
  const registers = await (await fetch(`${API}/v1/pos/registers`, { headers: h })).json();
  const lag2 = registers.find((r: any) => r.code === 'LAG2');
  const session = await (await fetch(`${API}/v1/pos/registers/${lag2.id}/sessions`, { method: 'POST', headers: { ...h, 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ openingFloatMinor: 0 }) })).json();
  const pack = await (await fetch(`${API}/v1/pos/registers/${lag2.id}/offline-pack`, { headers: h })).json();
  const lace = pack.items.find((i: any) => i.name === 'Lace Fabric');
  const sale = { clientSaleId: crypto.randomUUID(), registerId: lag2.id, sessionId: session.id, soldAt: new Date().toISOString(), localReceiptNo: 'OFF-X-1', lines: [{ variantId: lace.variantId, quantity: String(Number(lace.available) + 2) }], tillTotalMinor: 100000000, tenderedMinor: 100000000 };
  const res = await (await fetch(`${API}/v1/pos/offline-sales`, { method: 'POST', headers: h, body: JSON.stringify({ sales: [sale] }) })).json();
  expect(res.results[0]).toMatchObject({ status: 'created', shortages: 1 });

  await signIn(page, 'admin@e2e.test');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Offline shortfalls' }).click();
  const card = page.getByRole('article', { name: 'Shortfall of Lace Fabric' });
  await expect(card).toContainText('2 short');
  await expect(card).toContainText('till receipt OFF-X-1');
  await card.getByLabel('What was found').fill('Late receipt of 2 m not yet posted');
  await card.getByRole('button', { name: 'Mark as explained' }).click();
  await expect(page.getByText('Nothing here.')).toBeVisible();
  await noA11yViolations(page);
  // leave the drawer closed for the specs that follow
  await fetch(`${API}/v1/pos/sessions/${session.id}/close`, { method: 'POST', headers: { ...h, 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ countedCashMinor: 100000000 }) });
});
