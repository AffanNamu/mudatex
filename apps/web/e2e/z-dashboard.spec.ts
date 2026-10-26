import { expect, test } from '@playwright/test';
import { noA11yViolations, signIn } from './helpers';

// Named to run last, so the till and online specs have already made sales for it to report.
test('the home page shows how the business is doing, and says what needs attention', async ({ page }) => {
  await signIn(page, 'admin@e2e.test');
  const dash = page.getByRole('region', { name: 'Dashboard' });
  await expect(dash.getByRole('heading', { name: 'How we are doing' })).toBeVisible();
  const ngn = dash.getByRole('article', { name: 'Sales in NGN' });
  await expect(ngn).toBeVisible();
  await expect(ngn.getByTestId('total-NGN')).not.toHaveText('₦0.00');
  await expect(ngn.getByRole('img', { name: /Daily sales/ })).toBeVisible();
  await expect(ngn.getByRole('table', { name: 'Best sellers' })).toContainText('Ankara Wax Print');
  // the chart's numbers are available as a table
  await ngn.getByText('Show the numbers').click();
  await expect(ngn.getByRole('table', { name: 'Sales by day' })).toBeVisible();
  await page.getByLabel('Period').selectOption({ label: 'Last 7 days' });
  await expect(ngn).toBeVisible();
  await noA11yViolations(page);
});

test('a clerk who may not see sales sees no dashboard', async ({ page }) => {
  await signIn(page, 'clerk@e2e.test');
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Dashboard' })).toHaveCount(0);
});
