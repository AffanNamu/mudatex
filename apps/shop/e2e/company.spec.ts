import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { admin } from './helpers';

test.describe('the company pages', () => {
  test('a wholesale enquiry reaches the staff inbox', async ({ page }) => {
    await page.goto('/wholesale');
    await page.getByLabel('Your name').fill('Hajiya Zainab');
    await page.getByLabel('Business name (optional)').fill('Zainab Fabrics');
    await page.getByLabel('Phone / WhatsApp').fill('+2348030000000');
    await page.getByLabel('What do you buy, and how much?').fill('200 rolls of Atampa a month, delivered to Kaduna.');
    await page.getByRole('button', { name: 'Request wholesale prices' }).click();
    await expect(page.getByRole('heading', { name: /we have your message/ })).toBeVisible();
    const inbox = await admin('GET', '/v1/enquiries?kind=wholesale&status=new');
    expect(inbox).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Hajiya Zainab', company: 'Zainab Fabrics', phone: '+2348030000000' })]));
  });

  test('the form explains what is missing', async ({ page }) => {
    await page.goto('/contact');
    await page.getByLabel('Your name').fill('No Contact');
    await page.getByLabel('How can we help?').fill('Please call me back about my order.');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('p.err')).toContainText(/email address or a phone number/);
  });

  test('brands, divisions, locations, careers and made-to-order pages load and pass the accessibility checks', async ({ page }) => {
    for (const [path, heading] of [['/about', 'Our story'], ['/brands', 'Our brands'], ['/divisions', 'What we do'], ['/locations', 'Find us'], ['/careers', 'Work with us'], ['/custom-orders', 'Made to order'], ['/delivery', 'Delivery & returns']] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(results.violations.map((v) => `${path}: ${v.id} ${v.nodes[0]?.html}`)).toEqual([]);
    }
    await page.goto('/brands');
    await page.getByRole('link', { name: 'Empire Atampa' }).click();
    await expect(page).toHaveURL(/q=Empire/);
    await expect(page.locator('article')).toHaveCount(2);
  });
});
