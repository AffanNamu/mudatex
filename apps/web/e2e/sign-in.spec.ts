import { expect, test, type Page } from '@playwright/test';
import { noA11yViolations } from './helpers';

// Everything here runs the console in "real sign-in" mode against a stand-in for Supabase Auth.
const MOCK = 'http://localhost:3200';
const PASSWORD = 'correct-horse-battery';

async function useSupabase(page: Page) {
  await page.route('**/config.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: `window.__MUDATEX__ = { apiUrl: "http://localhost:3100", supabaseUrl: "${MOCK}", supabaseKey: "e2e-publishable-key" };` }));
}
const stats = async (page: Page) => (await (await page.request.get(`${MOCK}/__stats`)).json()) as { refreshes: number; logouts: number };

test.beforeEach(async ({ page }) => { await useSupabase(page); });

test('asks for a password, explains wrong passwords, and signs in', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByText('Development sign-in')).toHaveCount(0);
  await noA11yViolations(page);

  await page.getByLabel('Email').fill('cashier@e2e.test');
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong email or password.');

  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Cashier Chi' })).toBeVisible();
});

test('an unconfirmed email and an unknown Mudatex user get distinct, plain messages', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill('unconfirmed@e2e.test');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Confirm your email address first');

  // Signed in with the provider, but nobody set this person up in Mudatex.
  await page.getByLabel('Email').fill('stranger@e2e.test');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('have not been set up in Mudatex yet');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('the session is refreshed before it expires, and a revoked session signs the person out', async ({ page }) => {
  const before = (await stats(page)).refreshes;
  await page.goto('/');
  await page.getByLabel('Email').fill('receiver@e2e.test');   // this user gets a 6-second token
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();

  await expect.poll(async () => (await stats(page)).refreshes, { timeout: 10_000 }).toBeGreaterThan(before);
  await page.waitForTimeout(7_000);   // longer than the first token lived
  await page.getByRole('link', { name: 'Purchasing' }).click();
  await expect(page.getByRole('heading', { name: 'Purchasing' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);   // the API still accepted the person's requests

  await page.request.post(`${MOCK}/__revoke?prefix=receiver@`);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 15_000 });
});

test('signing out tells the provider and a reload stays signed out', async ({ page }) => {
  const before = (await stats(page)).logouts;
  await page.goto('/');
  await page.getByLabel('Email').fill('clerk@e2e.test');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect((await stats(page)).logouts).toBe(before + 1);
  await page.reload();
  await expect(page.getByLabel('Password')).toBeVisible();
});

test('a reset request never reveals whether the address has an account', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Forgot your password?' }).click();
  await page.getByLabel('Email').fill('anyone@e2e.test');
  await page.getByRole('button', { name: 'Email me a reset link' }).click();
  await expect(page.getByRole('status')).toHaveText('If that address has an account, a reset link is on its way.');
  await expect(page.getByLabel('Password')).toHaveCount(0);
});

test('a reset or invitation link lets the person choose a password, and the token leaves the address bar', async ({ page }) => {
  await page.goto('/#access_token=valid-link-token&type=recovery&expires_in=3600');
  await expect(page.getByRole('heading', { name: 'Choose a password' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect(page.url()).not.toContain('access_token');
  await noA11yViolations(page);

  await page.getByLabel('New password').fill('short');
  await expect(page.getByRole('button', { name: 'Save password' })).toBeDisabled();
  await page.getByLabel('New password').fill('a-long-enough-password');
  await page.getByLabel('Type it again').fill('a-different-password');
  await expect(page.getByText('The two do not match')).toBeVisible();
  await page.getByLabel('Type it again').fill('a-long-enough-password');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByText('Your password is saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Go to sign in' }).click();
  await expect(page.getByLabel('Password')).toBeVisible();
});

test('an expired link is explained', async ({ page }) => {
  await page.goto('/#access_token=stale&type=invite');
  await page.getByLabel('New password').fill('a-long-enough-password');
  await page.getByLabel('Type it again').fill('a-long-enough-password');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('alert')).toContainText('expired or was already used');
});

test('a person with an authenticator app is asked for a code after the password, and a wrong code does not let them in', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill('planner@e2e.test');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Enter the 6-digit code from your authenticator app.')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await noA11yViolations(page);

  await page.getByLabel('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toContainText('not right');
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);

  await page.getByLabel('6-digit code').fill('123 456');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // a reload keeps the stronger session: no second question
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
});

test('a person turns two-step sign-in on from the Security page and is asked for a code from then on', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill('storeman@e2e.test');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Security' }).click();
  await expect(page.getByText(/^Off\./)).toBeVisible();
  await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  await expect(page.getByText('JBSWY3DPEHPK3PXP')).toBeVisible();
  await noA11yViolations(page);
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
  await expect(page.getByText('Two-step sign-in is on.')).toBeVisible();
  await expect(page.getByText(/^On\./)).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Email').fill('storeman@e2e.test');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // turning it off again needs the stronger session, which this one has
  await page.getByRole('link', { name: 'Security' }).click();
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Removed.')).toBeVisible();
  await expect(page.getByText(/^Off\./)).toBeVisible();
});
