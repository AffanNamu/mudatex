import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('browsing the shop', () => {
  test('home shows the departments and featured fabrics with server prices', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.topbar')).toHaveText('Free delivery over ₦100,000');
    await expect(page.getByRole('heading', { name: 'Shop by department' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ankara' }).first()).toBeVisible();
    // 1,000 per metre plus 7.5% tax, rounded to the kobo by the server
    const card = page.locator('article', { hasText: 'Ankara Wax Print' });
    await expect(card.getByText('₦1,075.00')).toBeVisible();
    await expect(card.getByText('New')).toBeVisible();
    await expect(page.locator('article', { hasText: 'Brocade Gold' }).getByText('Sold out')).toBeVisible();
  });

  test('filters, searches and sorts the listing', async ({ page }) => {
    await page.goto('/shop');
    await expect(page.getByText('4 products')).toBeVisible();
    await page.getByRole('link', { name: /Lace \(2\)/ }).click();
    await expect(page.getByText('2 products')).toBeVisible();
    await expect(page.locator('article')).toHaveCount(2);

    await page.goto('/shop?sort=price_desc');
    await expect(page.locator('article').first()).toContainText('Brocade Gold');
    await page.goto('/shop?sort=price_asc');
    await expect(page.locator('article').first()).toContainText('Ankara Wax Print');

    await page.goto('/shop?inStock=true');
    await expect(page.getByText('3 products')).toBeVisible();
    await expect(page.locator('article', { hasText: 'Brocade Gold' })).toHaveCount(0);

    await page.goto('/shop');
    await page.getByRole('searchbox', { name: 'Search the shop' }).fill('swiss');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/q=swiss/);
    await expect(page.locator('article')).toHaveCount(1);

    await page.goto('/shop?q=zzzz');
    await expect(page.getByRole('heading', { name: 'Nothing matches yet' })).toBeVisible();
  });

  test('a product page shows availability and validates the quantity', async ({ page }) => {
    await page.goto('/product/swiss-lace');
    await expect(page.getByRole('heading', { name: 'Swiss Lace' })).toBeVisible();
    await expect(page.getByText('Only 3 m left')).toBeVisible();
    await page.getByLabel(/Quantity/).fill('1.234');
    await expect(page.getByText('up to 2 decimal places')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add to basket' })).toBeDisabled();
    await page.getByLabel(/Quantity/).fill('5');
    await expect(page.getByText('We only have 3 m right now.')).toBeVisible();
    await page.getByLabel(/Quantity/).fill('2');
    await expect(page.getByText('Total: ₦5,375.00')).toBeVisible();

    await page.goto('/product/brocade-gold');
    await expect(page.getByText(/Sold out/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add to basket' })).toHaveCount(0);

    await page.goto('/product/not-a-real-thing');
    await expect(page.getByRole('heading', { name: /couldn.t find that/ })).toBeVisible();
  });

  test('has no detectable accessibility violations on the main pages', async ({ page }) => {
    for (const path of ['/', '/shop', '/product/ankara-wax-print', '/cart', '/login', '/contact']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(results.violations.map((v) => `${path}: ${v.id} ${v.nodes[0]?.html}`), path).toEqual([]);
    }
  });
});
