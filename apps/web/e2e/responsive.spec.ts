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
