import { expect, test, type Page } from '@playwright/test';
import { noA11yViolations, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const goToPurchasing = async (page: Page) => { await nav(page).getByRole('link', { name: 'Purchasing' }).click(); };
const openOrder = async (page: Page, number: string) => { await page.getByRole('button', { name: number }).click(); };

let firstOrder = '';

test('a buyer drafts a two-line order and the server totals it', async ({ page }) => {
  await signIn(page, 'buyer@e2e.test');
  await goToPurchasing(page);
  await page.getByText('New purchase order').click();
  await page.getByLabel('Product 1').selectOption({ label: 'Ankara Wax Print (ANK-001)' });
  await page.getByLabel('Quantity 1').fill('100');
  await page.getByLabel('Unit price 1').fill('12.5');
  await expect(page.getByRole('button', { name: 'Save as draft' })).toBeEnabled();
  await page.getByRole('button', { name: 'Add a line' }).click();
  await page.getByLabel('Product 2').selectOption({ label: 'Silk Roll (SLK-R1)' });
  await page.getByLabel('Quantity 2').fill('10');
  await page.getByLabel('Unit price 2').fill('abc');
  await expect(page.getByText('Such as 12.5')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save as draft' })).toBeDisabled();
  await page.getByLabel('Unit price 2').fill('30');
  await noA11yViolations(page);
  await page.getByRole('button', { name: 'Save as draft' }).click();

  const heading = page.getByRole('heading', { level: 2, name: /^PO-.* · Draft$/ });
  await expect(heading).toBeVisible();
  firstOrder = (await heading.textContent())!.split(' ')[0]!;
  await expect(page.getByRole('cell', { name: '$1,550.00' })).toBeVisible();   // 100 × 12.50 + 10 × 30.00, worked out by the server
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByRole('heading', { level: 2, name: /Awaiting approval/ })).toBeVisible();
});

test('the buyer cannot approve their own order, someone else can', async ({ browser }) => {
  const buyer = await (await browser.newContext()).newPage();
  await signIn(buyer, 'buyer@e2e.test');
  await goToPurchasing(buyer);
  await openOrder(buyer, firstOrder);
  await expect(buyer.getByText('You created this order, so someone else must approve it.')).toBeVisible();
  await buyer.getByRole('button', { name: 'Approve' }).click();
  await expect(buyer.getByRole('alert')).toContainText('cannot approve an order you created');

  const approver = await (await browser.newContext()).newPage();
  await signIn(approver, 'approver@e2e.test');
  await expect(nav(approver).getByRole('link', { name: 'Point of sale' })).toHaveCount(0);
  await goToPurchasing(approver);
  await expect(approver.getByText('New purchase order')).toHaveCount(0);   // approvers do not raise orders
  await openOrder(approver, firstOrder);
  await noA11yViolations(approver);
  await approver.getByRole('button', { name: 'Approve' }).click();
  await expect(approver.getByRole('heading', { level: 2, name: /Approved/ })).toBeVisible();
});

test('goods are received in parts; over-delivery, rejections and rolls are handled', async ({ page }) => {
  await signIn(page, 'receiver@e2e.test');
  await goToPurchasing(page);
  await openOrder(page, firstOrder);
  const receive = page.getByRole('form', { name: 'Receive goods' });
  await expect(receive.getByRole('button', { name: 'Record receipt' })).toBeDisabled();

  // more than ordered
  await receive.getByLabel('Accepted quantity, ANK-001').fill('150');
  await receive.getByRole('button', { name: 'Record receipt' }).click();
  await expect(page.getByRole('alert')).toContainText('exceeds what is outstanding');

  // a roll needs its code; a rejection needs its reason
  await receive.getByLabel('Accepted quantity, ANK-001').fill('60');
  await receive.getByLabel('Rejected quantity, ANK-001').fill('5');
  await expect(receive.getByText('Say why it was rejected')).toBeVisible();
  await receive.getByLabel('Rejection reason, ANK-001').fill('Water damaged');
  await receive.getByLabel('Accepted quantity, SLK-R1').fill('10');
  await expect(receive.getByText('Roll code is required')).toBeVisible();
  await receive.getByLabel('Roll code, SLK-R1').fill('R-001');
  await noA11yViolations(page);
  await receive.getByRole('button', { name: 'Record receipt' }).click();

  await expect(page.getByRole('heading', { level: 2, name: /Partly received/ })).toBeVisible();
  const ankara = page.getByRole('row', { name: /Ankara Wax Print/ }).getByRole('cell');
  await expect(ankara.nth(2)).toHaveText('60');    // received
  await expect(ankara.nth(3)).toHaveText('40');    // outstanding; the 5 rejected do not count
  await expect(page.getByText('Receipts: GRN-')).toBeVisible();

  await nav(page).getByRole('link', { name: 'Inventory' }).click();
  const roll = page.getByRole('row', { name: /Silk Roll/ });
  await expect(roll.getByRole('cell').nth(0)).toHaveText('R-001');
  await expect(roll.getByRole('cell').nth(1)).toHaveText('10');
});

test('an approver sends an order back with a reason and the buyer sees it', async ({ browser }) => {
  const buyer = await (await browser.newContext()).newPage();
  await signIn(buyer, 'buyer@e2e.test');
  await goToPurchasing(buyer);
  await buyer.getByText('New purchase order').click();
  await buyer.getByLabel('Quantity 1').fill('5');
  await buyer.getByLabel('Unit price 1').fill('99');
  await buyer.getByRole('button', { name: 'Save as draft' }).click();
  const heading = buyer.getByRole('heading', { level: 2, name: /^PO-.* · Draft$/ });
  await expect(heading).toBeVisible();
  const number = (await heading.textContent())!.split(' ')[0]!;
  await buyer.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(buyer.getByRole('heading', { level: 2, name: /Awaiting approval/ })).toBeVisible();

  const approver = await (await browser.newContext()).newPage();
  await signIn(approver, 'approver@e2e.test');
  await goToPurchasing(approver);
  await openOrder(approver, number);
  await expect(approver.getByRole('button', { name: 'Send back' })).toBeDisabled();
  await approver.getByLabel(/Note \(required to send back\)/).fill('Price looks too high');
  await approver.getByRole('button', { name: 'Send back' }).click();
  await expect(approver.getByRole('heading', { level: 2, name: /Draft/ })).toBeVisible();

  await buyer.reload();
  await goToPurchasing(buyer);
  await openOrder(buyer, number);
  await expect(buyer.getByText('Approver’s note: Price looks too high')).toBeVisible();
});
