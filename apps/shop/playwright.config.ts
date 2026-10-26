import { defineConfig, devices } from '@playwright/test';

const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgres://mudatex:mudatex@localhost:5432/mudatex_e2e';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const SECRET = 'e2e-dev-secret-e2e-dev-secret-0001';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false, // orders are numbered in sequence and stock is shared
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://localhost:3300', trace: 'retain-on-failure', launchOptions: { executablePath } },
  projects: [
    { name: 'desktop', testIgnore: 'responsive.spec.ts', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } } },
    { name: 'phone', testMatch: 'responsive.spec.ts', use: { ...devices['Pixel 7'], launchOptions: { executablePath } } },
  ],
  webServer: [
    { command: 'node ../web/e2e/mock-supabase.mjs', url: 'http://localhost:3200/__stats', reuseExistingServer: false, env: { AUTH_DEV_SECRET: SECRET } },
    { command: 'node e2e/mock-paystack.mjs', url: 'http://localhost:3400/__stats', reuseExistingServer: false },
    {
      // Reset, migrate, start the API and seed the shop. Build the API first (npm run build in apps/api).
      command: 'node e2e/serve-api.mjs',
      url: 'http://localhost:3199',
      reuseExistingServer: false,
      timeout: 90_000,
      env: { DATABASE_URL, PORT: '3100', NODE_ENV: 'development', DEV_TOKEN_ENDPOINT: 'true', AUTH_DEV_SECRET: SECRET, CORS_ORIGINS: 'http://localhost:3300', RATE_LIMIT_MAX: '100000', PAYSTACK_SECRET_KEY: 'sk_test_e2esecret123456', PAYSTACK_BASE_URL: 'http://localhost:3400' },
    },
    {
      command: 'rm -rf .next && npm run build && npm run start -- -p 3300',
      url: 'http://localhost:3300',
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        NEXT_PUBLIC_API_URL: 'http://localhost:3100', NEXT_PUBLIC_SHOP_SLUG: 'e2e-shop', NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:3200',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'e2e-publishable-key', NEXT_PUBLIC_SITE_URL: 'http://localhost:3300',
      },
    },
  ],
});
