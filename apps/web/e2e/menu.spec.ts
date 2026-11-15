import { expect, test } from '@playwright/test';
import { noA11yViolations, signIn } from './helpers';

test('the menu is grouped, and people see only the groups they have a use for', async ({ page }) => {
  await signIn(page, 'admin@e2e.test');
  const menu = page.getByRole('navigation', { name: 'Main' });
  for (const group of ['Sell', 'Online', 'Wholesale', 'Stock', 'Buy and make', 'Money', 'Company']) await expect(menu.getByRole('group', { name: group })).toBeVisible();
  await expect(menu.getByRole('group', { name: 'Online' }).getByRole('link', { name: 'Online orders' })).toBeVisible();
  await expect(menu.getByRole('group', { name: 'Money' }).getByRole('link', { name: 'Accounting' })).toBeVisible();
  await menu.getByRole('link', { name: 'Customers' }).click();
  await expect(menu.getByRole('link', { name: 'Customers' })).toHaveClass(/active/);
  await noA11yViolations(page);
  await page.getByRole('button', { name: 'Sign out' }).click();

  // a cashier has a till and nothing else to show
  await signIn(page, 'cashier@e2e.test');
  await expect(menu.getByRole('group', { name: 'Sell' })).toBeVisible();
  for (const group of ['Money', 'Company', 'Buy and make', 'Wholesale']) await expect(menu.getByRole('group', { name: group })).toHaveCount(0);
  await expect(menu.getByRole('link', { name: 'People & access' })).toHaveCount(0);
});
