import { expect, test, type Page } from '@playwright/test';
import { noA11yViolations, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const section = (page: Page, name: string) => page.getByRole('navigation', { name: 'Accounting sections' }).getByRole('link', { name });
async function openBooks(page: Page, tab: string) {
  await nav(page).getByRole('link', { name: 'Accounting' }).click();
  await section(page, tab).click();
}
async function draftJournal(page: Page, description: string, amount: string) {
  await page.getByText('New journal').click();
  await page.getByLabel('Description').fill(description);
  await page.getByLabel('Account 1').selectOption({ label: '1000 Cash' });
  await page.getByLabel('Account 2').selectOption({ label: '3000 Capital' });
  await page.getByLabel('Debit 1').fill(amount);
  await page.getByLabel('Credit 2').fill(amount);
  await page.getByRole('button', { name: 'Save as draft' }).click();
}

test('an administrator adds an account to the chart', async ({ page }) => {
  await signIn(page, 'admin@e2e.test');
  await openBooks(page, 'Chart of accounts');
  await expect(page.getByRole('row', { name: /1000 Cash/ })).toBeVisible();
  await page.getByText('New account').click();
  await page.getByLabel('Code').fill('1100');
  await page.getByLabel('Account name').fill('Bank');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByText('Added 1100 Bank.')).toBeVisible();
  await expect(page.getByRole('row', { name: /1100/ })).toBeVisible();
  await noA11yViolations(page);
});

test('a bookkeeper cannot save an unbalanced journal; a balanced one becomes a draft that only someone else can post', async ({ page }) => {
  await signIn(page, 'bookkeeper@e2e.test');
  await openBooks(page, 'Journals');
  await page.getByText('New journal').click();
  await page.getByLabel('Description').fill('Opening capital');
  await page.getByLabel('Account 1').selectOption({ label: '1000 Cash' });
  await page.getByLabel('Account 2').selectOption({ label: '3000 Capital' });
  await page.getByLabel('Debit 1').fill('1,000.00');
  await page.getByLabel('Credit 2').fill('900');
  await expect(page.getByRole('status').filter({ hasText: 'out by ₦100.00' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save as draft' })).toBeDisabled();
  await page.getByLabel('Credit 2').fill('1000');
  await expect(page.getByRole('status').filter({ hasText: 'balanced' })).toBeVisible();
  await noA11yViolations(page);
  await page.getByRole('button', { name: 'Save as draft' }).click();

  await expect(page.getByRole('heading', { level: 2, name: 'Draft journal · draft' })).toBeVisible();
  await expect(page.getByRole('row', { name: /1000 Cash/ })).toContainText('₦1,000.00');
  await expect(page.getByRole('button', { name: 'Post journal' })).toHaveCount(0);   // bookkeepers do not post
  await expect(page.getByRole('button', { name: 'Delete draft' })).toBeVisible();
});

test('the accountant posts it and it gets a number; nobody can post their own', async ({ browser }) => {
  const accountant = await (await browser.newContext()).newPage();
  await signIn(accountant, 'accountant@e2e.test');
  await expect(nav(accountant).getByRole('link', { name: 'Point of sale' })).toHaveCount(0);
  await openBooks(accountant, 'Journals');
  await accountant.getByRole('button', { name: 'Draft' }).click();
  await accountant.getByRole('button', { name: 'Post journal' }).click();
  await expect(accountant.getByRole('heading', { level: 2, name: 'JE-000001 · posted' })).toBeVisible();
  await noA11yViolations(accountant);

  // The administrator drafts and then tries to post it themselves.
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, 'admin@e2e.test');
  await openBooks(admin, 'Journals');
  await draftJournal(admin, 'Admin self-post attempt', '50');
  await expect(admin.getByText('You created this journal, so someone else must post it.')).toBeVisible();
  await admin.getByRole('button', { name: 'Post journal' }).click();
  await expect(admin.getByRole('alert')).toContainText('cannot post a journal you created');
  await admin.getByRole('button', { name: 'Delete draft' }).click();
  await expect(admin.getByText('New journal')).toBeVisible();   // back on the list
  await expect(admin.getByRole('cell', { name: 'JE-000001' }).or(admin.getByRole('rowheader', { name: 'JE-000001' }))).toBeVisible();
  await expect(admin.getByText('Admin self-post attempt')).toHaveCount(0);
});

test('the trial balance reflects posted journals only, balances, and drills into an account', async ({ page }) => {
  await signIn(page, 'accountant@e2e.test');
  await openBooks(page, 'Trial balance');
  await expect(page.getByText('Debits equal credits, and assets plus expenses equal liabilities, equity and revenue.')).toBeVisible();
  const cash = page.getByRole('row', { name: /1000 Cash/ });
  await expect(cash.getByRole('cell').nth(1)).toHaveText('₦1,000.00');   // debit; the unposted drafts are not counted
  await expect(page.getByRole('row', { name: /3000 Capital/ }).getByRole('cell').nth(2)).toHaveText('₦1,000.00');
  await noA11yViolations(page);
  await page.getByRole('button', { name: '1000 Cash' }).click();
  await expect(page.getByRole('row', { name: /JE-000001/ })).toContainText('₦1,000.00');
  await expect(page.getByRole('row', { name: /Closing balance/ })).toContainText('₦1,000.00');
});

test('a posted journal is corrected by a reversal that someone else posts', async ({ browser }) => {
  const bookkeeper = await (await browser.newContext()).newPage();
  await signIn(bookkeeper, 'bookkeeper@e2e.test');
  await openBooks(bookkeeper, 'Journals');
  await bookkeeper.getByRole('button', { name: 'JE-000001' }).click();
  await bookkeeper.getByLabel('Reason').fill('Posted to the wrong company');
  await bookkeeper.getByRole('button', { name: 'Create reversal draft' }).click();
  await expect(bookkeeper.getByText('This journal reverses an earlier one.')).toBeVisible();

  const accountant = await (await browser.newContext()).newPage();
  await signIn(accountant, 'accountant@e2e.test');
  await openBooks(accountant, 'Journals');
  await accountant.getByRole('button', { name: 'Draft' }).click();
  await accountant.getByRole('button', { name: 'Post journal' }).click();
  await expect(accountant.getByRole('heading', { level: 2, name: 'JE-000002 · posted' })).toBeVisible();

  await section(accountant, 'Journals').click();
  await accountant.getByRole('button', { name: 'JE-000001' }).click();
  await expect(accountant.getByText('This journal has been reversed.')).toBeVisible();
  await expect(accountant.getByRole('button', { name: 'Create reversal draft' })).toHaveCount(0);
  await openBooks(accountant, 'Trial balance');
  await expect(accountant.getByRole('row', { name: /1000 Cash/ })).toContainText('₦0.00');
});

test('periods: closing, the two-person rule for reopening, and the reason is kept', async ({ browser }) => {
  const controller = await (await browser.newContext()).newPage();
  await signIn(controller, 'controller@e2e.test');
  await openBooks(controller, 'Periods');
  await controller.getByRole('button', { name: 'Close Old 2019' }).click();
  await expect(controller.getByRole('row', { name: /Old 2019/ })).toContainText('closed');
  await controller.getByRole('button', { name: 'Reopen Old 2019' }).click();
  await controller.getByLabel('Reason').fill('Late invoice found');
  await controller.getByRole('button', { name: 'Reopen period' }).click();
  await expect(controller.getByRole('alert')).toContainText('different person');
  await noA11yViolations(controller);

  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, 'admin@e2e.test');
  await openBooks(admin, 'Periods');
  await admin.getByRole('button', { name: 'Reopen Old 2019' }).click();
  await admin.getByLabel('Reason').fill('Late invoice found');
  await admin.getByRole('button', { name: 'Reopen period' }).click();
  await expect(admin.getByRole('row', { name: /Old 2019/ })).toContainText('reopened: Late invoice found');
});

test('exchange rates need a second person to approve', async ({ browser }) => {
  const entry = await (await browser.newContext()).newPage();
  await signIn(entry, 'rates@e2e.test');
  await openBooks(entry, 'Exchange rates');
  await entry.getByText('Enter a rate').click();
  await entry.getByLabel('From currency').fill('usd');
  await entry.getByLabel('To currency').fill('NGN');
  await entry.getByRole('textbox', { name: /^Rate/ }).fill('1550.25');
  await entry.getByLabel('Source').fill('Central bank');
  await entry.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(entry.getByText('Rate submitted.')).toBeVisible();
  await expect(entry.getByRole('row', { name: /USD → NGN/ })).toContainText('pending');
  await expect(entry.getByRole('button', { name: /^Approve/ })).toHaveCount(0);

  const approver = await (await browser.newContext()).newPage();
  await signIn(approver, 'rates-approver@e2e.test');
  await openBooks(approver, 'Exchange rates');
  await noA11yViolations(approver);
  await approver.getByRole('button', { name: /^Approve USD to NGN/ }).click();
  await expect(approver.getByRole('row', { name: /USD → NGN/ })).toContainText('approved');
});
