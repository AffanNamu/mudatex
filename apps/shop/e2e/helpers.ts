import { expect, type Page } from '@playwright/test';

export const API = 'http://localhost:3100';

export async function adminToken(): Promise<string> {
  const res = await fetch(`${API}/v1/dev/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@e2e.test' }) });
  return (await res.json()).token;
}

export async function admin<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await adminToken()}`, 'idempotency-key': crypto.randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export const uniqueEmail = (prefix = 'shopper') => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@e2e.test`;

/** Creates an account through the sign-up form (the stand-in identity service signs the shopper straight in). */
export async function signUp(page: Page, email = uniqueEmail(), next = '/account') {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByRole('button', { name: /new here/i }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  return email;
}

export async function completeProfile(page: Page, name = 'Amina Yusuf', phone = '+2348012345678') {
  await expect(page.getByRole('heading', { name: 'Tell us who you are' })).toBeVisible();
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Continue' }).click();
}
