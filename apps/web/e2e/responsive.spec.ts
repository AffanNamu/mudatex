import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('the till and the stock page fit a phone screen without sideways scrolling', async ({ page }) => {
  await signIn(page, 'supervisor@e2e.test');
  for (const path of ['/', '/pos', '/inventory']) {
    await page.goto(path);
    await expect(page.getByRole('main')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
  }
});

test('on a phone the menu is folded behind a button, opens, and folds again after a choice', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the folded menu is for phones');
  await signIn(page, 'admin@e2e.test');
  const menu = page.getByRole('navigation', { name: 'Main' });
  const toggle = menu.getByRole('button', { name: 'Menu' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(menu.getByRole('link', { name: 'Inventory' })).toBeHidden();
  await toggle.click();
  await expect(menu.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
  await menu.getByRole('link', { name: 'Inventory' }).click();
  await expect(page.getByRole('main')).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Inventory' })).toBeHidden();   // folded again
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
