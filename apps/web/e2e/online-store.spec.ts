import { expect, test } from '@playwright/test';
import { noA11yViolations, signIn } from './helpers';

const nav = (page: import('@playwright/test').Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();

test('an administrator configures tax in Setup', async ({ page }) => {
  await signIn(page, 'admin@e2e.test');
  await nav(page, 'Setup');
  await expect(page.getByRole('heading', { name: 'Business setup' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'E2E Nigeria Ltd' }).first()).toBeVisible();
  await page.getByText('Add a tax code').click();
  const tax = page.locator('details', { hasText: 'Add a tax code' });
  await tax.getByLabel('Code').fill('VAT5');
  await tax.getByLabel('Name').fill('VAT 5%');
  await tax.getByLabel('Rate (%)').fill('5');
  await tax.getByRole('button', { name: 'Add tax code' }).click();
  await expect(page.getByText('Created VAT5.')).toBeVisible();
  await expect(page.getByRole('row', { name: /VAT5/ })).toContainText('5%');
  // a rate above 100% is explained, not sent
  await page.getByLabel('Rate (%)').fill('150');
  await expect(page.getByText('Enter a percentage below 100')).toBeVisible();
  await noA11yViolations(page);
});

test('an administrator opens an online store, publishes a product and sets delivery', async ({ page, request }) => {
  await signIn(page, 'admin@e2e.test');
  await nav(page, 'Online store');
  await expect(page.getByText('You have no online store yet')).toBeVisible();
  await page.getByText('Create a store').click();
  await page.getByLabel('Store name').fill('Console Shop');
  await page.getByRole('button', { name: 'Create store' }).click();
  await expect(page.getByText(/Created “Console Shop”/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /Console Shop/ })).toBeVisible();

  // not live: shoppers see nothing
  expect((await request.get('http://localhost:3100/shop/console-shop')).status()).toBe(404);
  // cannot go live with nothing published
  await page.getByRole('button', { name: 'Go live' }).click();
  await expect(page.getByRole('alert')).toContainText('Publish at least one product');

  await page.getByLabel('New department').fill('Lace');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Added Lace.')).toBeVisible();

  await page.getByRole('row', { name: /Ankara Wax Print/ }).getByRole('button', { name: 'Add to store' }).click();
  const listing = page.getByRole('form', { name: /Online listing for Ankara Wax Print/ });
  await listing.getByLabel('Department').selectOption({ label: 'Lace' });
  await listing.getByLabel('Picture links (https), one per line').fill('https://img.example.test/ankara.jpg');
  await listing.getByLabel('Visible in the shop').check();
  await listing.getByRole('button', { name: 'Save listing' }).click();
  await expect(page.getByRole('row', { name: /Ankara Wax Print/ })).toContainText('Published');

  await page.getByLabel('Zone name').fill('Lagos');
  await page.getByLabel('States').fill('Lagos');
  await page.getByLabel('Delivery fee').fill('1500');
  await page.getByRole('button', { name: 'Add zone' }).click();
  await expect(page.getByText('Added Lagos.')).toBeVisible();

  await page.getByRole('button', { name: 'Go live' }).click();
  await expect(page.getByText('Store is now live.')).toBeVisible();

  const shop = await request.get('http://localhost:3100/shop/console-shop');
  expect(shop.status()).toBe(200);
  const list = await (await request.get('http://localhost:3100/shop/console-shop/products')).json();
  expect(list.items).toEqual([expect.objectContaining({ slug: 'ankara-wax-print', priceMinor: 107500, inStock: true, images: ['https://img.example.test/ankara.jpg'] })]);
  const quote = await (await request.post('http://localhost:3100/shop/console-shop/delivery-quote', { data: { countryCode: 'NG', state: 'Lagos', subtotalMinor: 100 } })).json();
  expect(quote).toMatchObject({ zone: 'Lagos', feeMinor: 150000 });
  await noA11yViolations(page);
});

test('the order desk starts empty and people without the permission do not see it', async ({ page }) => {
  await signIn(page, 'admin@e2e.test');
  await nav(page, 'Online orders');
  await expect(page.getByRole('heading', { name: 'Online orders' })).toBeVisible();
  await expect(page.getByText('No orders yet.')).toBeVisible();
  await noA11yViolations(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'cashier@e2e.test');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Online orders' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Setup' })).toHaveCount(0);
});
