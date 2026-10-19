import { expect, test, type Page } from '@playwright/test';
import { noA11yViolations, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

async function sellAnkara(page: Page, qty: string, pay: () => Promise<void>) {
  await page.goto('/pos');
  await page.getByRole('button', { name: /^Ankara Wax Print/ }).click();
  await page.getByLabel('Quantity of Ankara Wax Print').fill(qty);
  await expect(page.getByTestId('total')).not.toHaveText('…');
  await pay();
  await page.getByRole('button', { name: /^Charge/ }).click();
}

test('a cash sale is partly returned, the refund is worked out by the server, and the last unit cannot be over-returned', async ({ page }) => {
  await signIn(page, 'cashier@e2e.test');
  await page.goto('/pos');
  await page.getByLabel(/Opening float/).fill('0');
  await page.getByRole('button', { name: 'Open session' }).click();
  await expect(page.getByRole('region', { name: 'Cart' })).toBeVisible();
  await sellAnkara(page, '2', async () => {});
  await expect(page.getByRole('heading', { name: /Receipt LAG1-000004/ })).toBeVisible();

  await nav(page).getByRole('link', { name: 'Returns' }).click();
  await page.getByLabel('Receipt number').fill('NOPE-1');
  await page.getByRole('button', { name: 'Find sale' }).click();
  await expect(page.getByRole('alert')).toContainText('No sale with receipt NOPE-1');

  await page.getByLabel('Receipt number').fill('LAG1-000004');
  await page.getByRole('button', { name: 'Find sale' }).click();
  const record = page.getByRole('button', { name: 'Record return' });
  await expect(record).toBeDisabled();
  await page.getByLabel('Return quantity for Ankara Wax Print').fill('3');   // sold 2
  await expect(record).toBeDisabled();
  await page.getByLabel('Reason').fill('Wrong colour');
  await page.getByLabel('Return quantity for Ankara Wax Print').fill('2');   // ₦2,150.00 is above this register's ₦2,000.00 refund limit
  await record.click();
  await expect(page.getByRole('alert')).toContainText('above the register limit');
  await page.getByLabel('Return quantity for Ankara Wax Print').fill('1');
  await noA11yViolations(page);
  await record.click();
  await expect(page.getByRole('status')).toContainText('Return R-LAG1-000001 recorded. Refund ₦1,075.00 by cash');

  await page.getByLabel('Receipt number').fill('LAG1-000004');
  await page.getByRole('button', { name: 'Find sale' }).click();
  await expect(page.getByRole('row', { name: /Ankara Wax Print/ }).getByRole('cell').nth(1)).toHaveText('1');   // already returned
  await page.getByLabel('Return quantity for Ankara Wax Print').fill('2');
  await expect(page.getByRole('button', { name: 'Record return' })).toBeDisabled();   // only 1 left
});

test('a card refund waits for a different person to pay it out', async ({ browser }) => {
  const cashier = await (await browser.newContext()).newPage();
  await signIn(cashier, 'cashier@e2e.test');
  await sellAnkara(cashier, '1', async () => {
    await cashier.getByText('Card', { exact: true }).click();
    await cashier.getByLabel('Provider reference').fill('CARD-REFUND-1');
  });
  await expect(cashier.getByText('Awaiting payment confirmation')).toBeVisible();

  const supervisor = await (await browser.newContext()).newPage();
  await signIn(supervisor, 'supervisor@e2e.test');
  await nav(supervisor).getByRole('link', { name: 'Confirm payments' }).click();
  await supervisor.getByRole('button', { name: /Confirm received, LAG1-000005/ }).click();
  await expect(supervisor.getByText('Nothing is waiting for confirmation.')).toBeVisible();

  await nav(cashier).getByRole('link', { name: 'Returns' }).click();
  await cashier.getByLabel('Receipt number').fill('LAG1-000005');
  await cashier.getByRole('button', { name: 'Find sale' }).click();
  await cashier.getByLabel('Return quantity for Ankara Wax Print').fill('1');
  await cashier.getByLabel('Reason').fill('Damaged in transit');
  await cashier.getByRole('button', { name: 'Record return' }).click();
  await expect(cashier.getByRole('status')).toContainText('a supervisor must confirm the payout');
  await expect(nav(cashier).getByRole('link', { name: 'Confirm payments' })).toHaveCount(0);   // the cashier cannot pay it out

  await supervisor.reload();
  await expect(supervisor.getByText('R-LAG1-000002 for LAG1-000005: ₦1,075.00 by card')).toBeVisible();
  await noA11yViolations(supervisor);
  await supervisor.getByLabel('Payout reference').fill('BANK-778');
  await supervisor.getByRole('button', { name: /Mark paid out, R-LAG1-000002/ }).click();
  await expect(supervisor.getByText('No refunds are waiting to be paid out.')).toBeVisible();
});
