import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('shop languages', () => {
  test('the shopper can switch to French or Hausa; the choice sticks and the page language follows', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Shop by department' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    await page.getByLabel('Language').selectOption('fr');
    await expect(page.getByRole('heading', { name: 'Acheter par rayon' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('article', { hasText: 'Brocade Gold' }).getByText('Épuisé')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Acheter par rayon' })).toBeVisible();

    await page.getByLabel('Langue').selectOption('ha');
    await expect(page.getByRole('heading', { name: 'Saya bisa sashe' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ha');

    await page.getByLabel('Harshe').selectOption('en');
    await expect(page.getByRole('heading', { name: 'Shop by department' })).toBeVisible();
  });

  test('the listing, the basket and the page for one product read in French, with prices unchanged', async ({ page }) => {
    await page.goto('/shop');
    await page.getByLabel('Language').selectOption('fr');
    await expect(page.getByText('4 produits')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Prix croissant' })).toBeVisible();
    await expect(page.locator('article', { hasText: 'Wax Ankara imprimé' }).getByText('₦1,075.00')).toBeVisible();

    await page.goto('/shop?q=zzzz');
    await expect(page.getByRole('heading', { name: 'Aucun résultat pour le moment' })).toBeVisible();

    await page.goto('/shop');
    await page.locator('article', { hasText: 'Wax Ankara imprimé' }).getByRole('link', { name: 'Wax Ankara imprimé' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Wax Ankara imprimé' })).toBeVisible();
    await expect(page.getByText('Un wax audacieux, aux couleurs solides.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ajouter au panier' })).toBeVisible();
    await page.getByRole('button', { name: 'Ajouter au panier' }).click();
    await expect(page.getByText('Ajouté à votre panier ✓')).toBeVisible();
    await page.getByRole('link', { name: 'Voir le panier' }).click();
    await expect(page.getByRole('heading', { name: 'Votre panier' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Wax Ankara imprimé' })).toBeVisible();
    await expect(page.getByText('Récapitulatif')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Passer la commande' })).toBeVisible();
  });

  test('French and Hausa pages have no accessibility violations', async ({ page }) => {
    for (const [lang, path] of [['fr', '/'], ['fr', '/shop'], ['ha', '/'], ['ha', '/delivery']] as const) {
      await page.goto(path);
      await page.getByLabel(/Language|Langue|Harshe/).selectOption(lang);
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(results.violations.map((v) => `${path} ${lang}: ${v.id}`)).toEqual([]);
    }
  });
});

test.describe('first visit from a French-language browser', () => {
  test.use({ locale: 'fr-FR' });
  test('starts in French, and an explicit choice wins from then on', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Acheter par rayon' })).toBeVisible();
    await page.getByLabel('Langue').selectOption('en');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Shop by department' })).toBeVisible();
  });
});

test.describe('company-written content', () => {
  test('is shown in the shopper\'s language where it has been translated, and in English where it has not', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.topbar')).toHaveText('Free delivery over ₦100,000');
    await page.getByLabel('Language').selectOption('fr');
    await expect(page.locator('.topbar')).toHaveText('Livraison gratuite dès 100 000 ₦');
    await expect(page.getByRole('link', { name: 'Dentelle' }).first()).toBeVisible();   // translated department
    await expect(page.getByRole('link', { name: 'Ankara' }).first()).toBeVisible();      // department with no translation
    await expect(page.locator('article', { hasText: 'Brocade Gold' })).toBeVisible();   // product with no translation

    await page.goto('/shop?department=lace');
    await expect(page.getByRole('heading', { level: 1, name: 'Dentelle' })).toBeVisible();

    await page.getByLabel('Langue').selectOption('ha');
    await expect(page.getByRole('heading', { level: 1, name: 'Leshi' })).toBeVisible();
    await expect(page.locator('.topbar')).toHaveText('Free delivery over ₦100,000');     // no Hausa tagline: the English shows
  });
});
