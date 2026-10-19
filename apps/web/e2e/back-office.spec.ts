import { expect, test } from '@playwright/test';
import { noA11yViolations, signIn } from './helpers';

test('an administrator adds a product and a duplicate SKU is explained', async ({ page }) => {
  await signIn(page, 'admin@e2e.test');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Catalogue' }).click();
  await page.getByText('New product').click();
  await page.getByLabel('Name').first().fill('Adire Indigo');
  await page.getByLabel('SKU').fill('ADR-001');
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByText('Created “Adire Indigo”.')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'ADR-001' })).toBeVisible();

  await page.getByLabel('Name').first().fill('Adire Again');
  await page.getByLabel('SKU').fill('ADR-001');
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('alert')).toContainText('That SKU already exists');
  await noA11yViolations(page);
});

test('a stock clerk receives stock and sees the balance rise', async ({ page }) => {
  await signIn(page, 'clerk@e2e.test');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Inventory' }).click();
  const row = page.getByRole('row', { name: /Lace Fabric/ });
  await expect(row.getByRole('cell').nth(1)).toHaveText('3');
  await page.getByText('Receive stock').click();
  await page.getByLabel('Product').selectOption({ label: 'Lace Fabric (LCE-001)' });
  await page.getByLabel('Quantity').fill('7.5');
  await page.getByRole('button', { name: 'Receive' }).click();
  await expect(page.getByText('Received 7.5 × Lace Fabric.')).toBeVisible();
  await expect(row.getByRole('cell').nth(1)).toHaveText('10.5');
  await noA11yViolations(page);
});

test('a clerk cannot create products: the form is not offered', async ({ page }) => {
  await signIn(page, 'clerk@e2e.test');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Catalogue' }).click();
  await expect(page.getByRole('heading', { name: 'Catalogue' })).toBeVisible();
  await expect(page.getByText('New product')).toHaveCount(0);
});
