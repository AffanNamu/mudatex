import { expect, test } from '@playwright/test';

test.describe('on a phone', () => {
  for (const path of ['/', '/shop', '/product/ankara-wax-print', '/cart', '/login']) {
    test(`${path} fits the screen`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test('the menu opens and reaches the departments', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Lace' }).click();
    await expect(page).toHaveURL(/department=lace/);
  });

  test('tap targets are large enough', async ({ page }) => {
    await page.goto('/product/ankara-wax-print');
    for (const name of ['Add to basket', 'Menu']) {
      const box = await page.getByRole('button', { name }).first().boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(40);
    }
  });
});
