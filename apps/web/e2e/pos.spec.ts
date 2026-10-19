import { expect, test, type Page } from '@playwright/test';
import { noA11yViolations, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });

const addAnkara = (page: Page) => page.getByRole('button', { name: /^Ankara Wax Print/ }).click();

test('open the till with a float', async ({ page }) => {
  await signIn(page, 'cashier@e2e.test');
  await page.getByRole('link', { name: 'Point of sale' }).click();
  await expect(page.getByRole('heading', { name: 'Open LAG1' })).toBeVisible();
  await page.getByLabel(/Opening float/).fill('abc');
  await expect(page.getByRole('button', { name: 'Open session' })).toBeDisabled();
  await page.getByLabel(/Opening float/).fill('100.00');
  await page.getByRole('button', { name: 'Open session' }).click();
  await expect(page.getByRole('region', { name: 'Cart' })).toBeVisible();
});

test('a cash sale: server-computed total, change, receipt', async ({ page }) => {
  await signIn(page, 'cashier@e2e.test');
  await page.goto('/pos');
  await addAnkara(page);
  await page.getByLabel('Quantity of Ankara Wax Print').fill('2');
  // 2 × 1,000.00 + 7.5% VAT, computed by the server
  await expect(page.getByTestId('total')).toHaveText('₦2,150.00');
  await page.getByLabel(/Cash tendered/).fill('3000');
  await expect(page.getByTestId('change')).toContainText('₦850.00');
  await noA11yViolations(page);
  await page.getByRole('button', { name: 'Charge ₦2,150.00' }).click();
  await expect(page.getByRole('heading', { name: /Receipt LAG1-000001/ })).toBeVisible();
  await expect(page.getByText('Sale complete.')).toBeVisible();
  await noA11yViolations(page);
  await page.getByRole('button', { name: 'New sale' }).click();
  await expect(page.getByText('Add products to start a sale.')).toBeVisible();
});

test('stock shortages block the sale', async ({ page }) => {
  await signIn(page, 'cashier@e2e.test');
  await page.goto('/pos');
  await page.getByRole('button', { name: /^Lace Fabric/ }).click();
  await page.getByLabel('Quantity of Lace Fabric').fill('5');
  await expect(page.getByText(/Only 10\.5 m available|Only 3 m available/)).toHaveCount(0); // 10.5 after the clerk's receipt, or 3 if run alone
  await page.getByLabel('Quantity of Lace Fabric').fill('500');
  await expect(page.getByText(/Only .* m available/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Charge/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear cart' }).click();
});

test('a discount above the register limit is refused with the reason', async ({ page }) => {
  await signIn(page, 'cashier@e2e.test');
  await page.goto('/pos');
  await addAnkara(page);
  await page.getByLabel('Discount percent for Ankara Wax Print').fill('50');
  await expect(page.getByRole('alert')).toContainText(/discount/i);
  await expect(page.getByRole('button', { name: /^Charge/ })).toHaveCount(0);
  await page.getByLabel('Discount percent for Ankara Wax Print').fill('10');
  await expect(page.getByTestId('total')).toHaveText('₦967.50'); // 900.00 + 7.5%
  await page.getByRole('button', { name: 'Clear cart' }).click();
});

test('a card sale waits for a supervisor to confirm payment', async ({ page }) => {
  await signIn(page, 'cashier@e2e.test');
  await page.goto('/pos');
  await addAnkara(page);
  await page.getByText('Card', { exact: true }).click();
  await expect(page.getByRole('button', { name: /^Charge/ })).toBeDisabled();
  await page.getByLabel('Provider reference').fill('POS-TERM-889');
  await page.getByRole('button', { name: /^Charge/ }).click();
  await expect(page.getByText('Awaiting payment confirmation')).toBeVisible();
  await page.getByRole('button', { name: 'New sale' }).click();
});

test('a supervisor confirms the card payment and only then does stock leave', async ({ page }) => {
  await signIn(page, 'supervisor@e2e.test');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const ankara = () => page.getByRole('row', { name: /Ankara Wax Print/ }).getByRole('cell');
  await nav.getByRole('link', { name: 'Inventory' }).click();
  await expect(ankara().nth(1)).toHaveText('48');   // 50 − 2 sold for cash
  await expect(ankara().nth(2)).toHaveText('1');    // 1 held for the card sale
  await nav.getByRole('link', { name: 'Confirm payments' }).click();
  await expect(page.getByText('POS-TERM-889')).toBeVisible();
  await noA11yViolations(page);
  await page.getByRole('button', { name: /Confirm received, LAG1-000002/ }).click();
  await expect(page.getByText('Nothing is waiting for confirmation.')).toBeVisible();
  await nav.getByRole('link', { name: 'Inventory' }).click();
  await expect(ankara().nth(1)).toHaveText('47');
  await expect(ankara().nth(2)).toHaveText('0');
});

test('the cashier cannot close with an unconfirmed sale, cancels it, then closes and sees the variance', async ({ page }) => {
  await signIn(page, 'cashier@e2e.test');
  await page.goto('/pos');
  await addAnkara(page);
  await page.getByText('Mobile money', { exact: true }).click();
  await page.getByLabel('Provider reference').fill('MM-1');
  await page.getByRole('button', { name: /^Charge/ }).click();
  await expect(page.getByText('Awaiting payment confirmation')).toBeVisible();
  await page.getByRole('button', { name: 'New sale' }).click();

  await page.getByRole('button', { name: 'Close session' }).click();
  await expect(page.getByText(/1 sale\(s\) are still awaiting payment confirmation/)).toBeVisible();
  await page.getByLabel(/Counted cash/).fill('2245.00');
  await page.getByRole('button', { name: 'Close session' }).last().click();
  await expect(page.getByRole('alert')).toContainText('Resolve pending-payment sales');

  await page.getByRole('button', { name: /Cancel sale LAG1-000003/ }).click();
  await expect(page.getByText(/still awaiting payment confirmation/)).toHaveCount(0);
  // float 100.00 + cash sale 2,150.00 = 2,250.00 expected; the cashier counts 2,245.00
  await page.getByRole('button', { name: 'Close session' }).last().click();
  await expect(page.getByRole('heading', { name: 'Session closed' })).toBeVisible();
  await expect(page.getByTestId('variance')).toHaveText('-₦5.00');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'Open LAG1' })).toBeVisible();
});
