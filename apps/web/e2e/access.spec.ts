import { expect, test } from '@playwright/test';
import { noA11yViolations, signIn } from './helpers';

test('an unknown email is refused with a clear message', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill('nobody@e2e.test');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('No active user');
  await noA11yViolations(page);
});

test('the menu shows only what the person may use, and direct links are refused too', async ({ page }) => {
  await signIn(page, 'cashier@e2e.test');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Point of sale' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Inventory' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Catalogue' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'People & access' })).toHaveCount(0);
  await page.goto('/access');
  await expect(page.getByText('You do not have access to this page.')).toBeVisible();
});

test('signing out returns to the sign-in page and the session does not survive a reload', async ({ page }) => {
  await signIn(page, 'clerk@e2e.test');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('a signed-in person stays signed in across a reload', async ({ page }) => {
  await signIn(page, 'admin@e2e.test');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome, Ada Admin' })).toBeVisible();
  await noA11yViolations(page);
});

test('administrators can see people and their access', async ({ page }) => {
  await signIn(page, 'admin@e2e.test');
  await page.getByRole('link', { name: 'People & access' }).click();
  await expect(page.getByText('cashier@e2e.test').first()).toBeVisible();
  await noA11yViolations(page);
});
