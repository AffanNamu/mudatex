import { expect, test } from '@playwright/test';
import { noA11yViolations, signIn } from './helpers';

const nav = (page: import('@playwright/test').Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();

// Last on purpose: sending an order takes a roll off the shelf for good, and the till tests expect the stock they were given.
test('staff set up delivery companies, send an order with one, and follow the parcel', async ({ page, request }) => {
  const { createHmac } = await import('node:crypto');
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const email = 'parcel-shopper@e2e.test';
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub: email, email, iat: now, exp: now + 3600, aud: 'authenticated' });
  const auth = { authorization: `Bearer ${head}.${body}.${createHmac('sha256', 'e2e-dev-secret-e2e-dev-secret-0001').update(`${head}.${body}`).digest('base64url')}` };
  test.skip((await request.get('http://localhost:3100/shop/console-shop')).status() !== 200, 'needs the store from the online-store tests');
  const api = 'http://localhost:3100';
  await request.post(`${api}/shop/console-shop/me`, { headers: auth, data: { fullName: 'Parcel Shopper' } });
  const address = await (await request.post(`${api}/shop/console-shop/me/addresses`, { headers: auth, data: { label: 'H', recipient: 'Parcel Shopper', phone: '+2348011111111', line1: '1 Road', city: 'Lagos', state: 'Lagos', countryCode: 'NG' } })).json();
  const variant = (await (await request.get(`${api}/shop/console-shop/products/ankara-wax-print`)).json()).variants[0].variantId;
  const placed = await request.post(`${api}/shop/console-shop/me/orders`, { headers: { ...auth, 'idempotency-key': crypto.randomUUID() }, data: { lines: [{ variantId: variant, quantity: '1' }], addressId: address.id, paymentMethod: 'bank_transfer' } });
  expect(placed.status()).toBe(201);
  const order = await placed.json();
  const adminTok = (await (await request.post(`${api}/v1/dev/token`, { data: { email: 'admin@e2e.test' } })).json()).token;
  expect((await request.post(`${api}/v1/sales-orders/${order.id}/payments`, { headers: { authorization: `Bearer ${adminTok}` }, data: { method: 'bank_transfer', reference: `PC-${Date.now()}`, amountMinor: order.totalMinor } })).status()).toBe(200);

  await signIn(page, 'admin@e2e.test');
  await nav(page, 'Delivery companies');
  await expect(page.getByRole('heading', { name: 'Delivery companies' })).toBeVisible();
  await page.getByRole('button', { name: 'Add a delivery company' }).click();
  const form = page.getByRole('form', { name: 'New delivery company' });
  await form.getByLabel('Name', { exact: true }).fill('Swift Test Express');
  await form.getByLabel('Their tracking page').fill('https://swift.example/track?no={ref}');
  await form.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('article', { name: 'Swift Test Express' })).toBeVisible();

  // a company that sends updates by itself gets a secret, shown once
  await page.getByRole('button', { name: 'Add a delivery company' }).click();
  await form.getByLabel('Name', { exact: true }).fill('Hooked Test Logistics');
  await form.getByLabel('How do updates arrive?').selectOption('webhook');
  await form.getByLabel('Their words for each stage').fill('picked = picked_up');
  await form.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText(/signing secret \(shown once\)/)).toBeVisible();
  await expect(page.getByText(/cws_/).first()).toBeVisible();
  await noA11yViolations(page);
  await page.getByRole('button', { name: 'I have saved it' }).click();
  await expect(page.getByText(/cws_/)).toHaveCount(0);

  await nav(page, 'Online orders');
  await page.getByRole('button', { name: order.orderNo }).first().click();
  const panel = page.getByRole('region', { name: `Order ${order.orderNo}` });
  await panel.getByLabel('Delivery company').selectOption({ label: 'Swift Test Express' });
  await panel.getByLabel('Tracking number').fill('SWT-9001');
  await panel.getByRole('button', { name: /Ship/ }).click();
  const parcel = panel.getByRole('region', { name: 'Parcel tracking' });
  await expect(parcel.getByRole('heading', { name: 'Parcel: Handed to the delivery company' })).toBeVisible();
  await expect(parcel.getByRole('link', { name: 'their tracking page' })).toHaveAttribute('href', 'https://swift.example/track?no=SWT-9001');

  await parcel.getByLabel('Add an update').selectOption('out_for_delivery');
  await parcel.getByLabel('Note').fill('With the rider');
  await parcel.getByRole('button', { name: 'Add update' }).click();
  await expect(parcel.getByRole('heading', { name: 'Parcel: Out for delivery' })).toBeVisible();
  await expect(parcel.getByText(/With the rider/)).toBeVisible();
  await noA11yViolations(page);
  await parcel.getByLabel('Add an update').selectOption('delivered');
  await parcel.getByRole('button', { name: 'Add update' }).click();
  await expect(parcel.getByRole('heading', { name: 'Parcel: Delivered' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: new RegExp(`${order.orderNo} Delivered`) })).toBeVisible();

  // the customer asks to send some back; staff decide in the order panel
  const asked = await request.post(`${api}/shop/console-shop/me/orders/${order.orderNo}/returns`, { headers: { ...auth, 'idempotency-key': crypto.randomUUID() }, data: { reason: 'damaged', note: 'Torn at the edge', lines: [{ lineNo: 1, quantity: '1' }] } });
  expect(asked.status()).toBe(201);
  await page.reload();
  await page.getByRole('button', { name: order.orderNo }).first().click();
  const again = page.getByRole('region', { name: `Order ${order.orderNo}` });
  const returns = again.getByRole('region', { name: 'Returns' });
  await expect(returns.getByText('Waiting for a decision')).toBeVisible();
  await expect(returns.getByText('Customer: Torn at the edge')).toBeVisible();
  await noA11yViolations(page);
  await returns.getByLabel('Note to the customer').fill('Sorry about that');
  await returns.getByRole('button', { name: /Approve/ }).click();
  await expect(returns.getByText('Approved, waiting for the goods')).toBeVisible();
  await returns.getByLabel(/Put .* back on the shelf/).check();
  await returns.getByRole('button', { name: 'Goods received' }).click();
  await expect(returns.getByText('Goods received')).toBeVisible();
  await expect(again.getByText(/Refund of \d+ requested/)).toBeVisible();
});

test('staff say which location sends orders for which states, and it is kept', async ({ page, request }) => {
  test.skip((await request.get('http://localhost:3100/shop/console-shop')).status() !== 200, 'needs the store from the online-store tests');
  const api = 'http://localhost:3100';
  const tok = (await (await request.post(`${api}/v1/dev/token`, { data: { email: 'admin@e2e.test' } })).json()).token;
  const h = { authorization: `Bearer ${tok}` };
  const store = (await (await request.get(`${api}/v1/storefronts`, { headers: h })).json()).find((s: any) => s.slug === 'console-shop');
  const loc = await (await request.post(`${api}/v1/locations`, { headers: h, data: { legalEntityId: store.legalEntityId, type: 'warehouse', name: 'Kano Warehouse', countryCode: 'NG', timezone: 'Africa/Lagos' } })).json();
  expect((await request.put(`${api}/v1/storefronts/${store.id}`, { headers: h, data: { stockLocationIds: [...store.stockLocationIds, loc.id] } })).status()).toBe(200);

  await signIn(page, 'admin@e2e.test');
  await nav(page, 'Online store');
  const section = page.getByRole('region', { name: 'Where orders are sent from' });
  await expect(section.getByText('No areas: orders are sent from the first location that has the goods.')).toBeVisible();
  await section.getByRole('button', { name: 'Add an area' }).click();
  await section.getByLabel('Location').selectOption({ label: 'Kano Warehouse' });
  await section.getByLabel('States').fill('Kano, Kaduna');
  await noA11yViolations(page);
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByText('Saved.')).toBeVisible();

  await page.reload();
  const again = page.getByRole('region', { name: 'Where orders are sent from' });
  await expect(again.getByLabel('States')).toHaveValue('kano, kaduna');
  await expect(again.getByLabel('Location')).toContainText('Kano Warehouse');
});
