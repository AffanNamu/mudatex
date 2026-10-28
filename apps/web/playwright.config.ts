import { defineConfig, devices } from '@playwright/test';

const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgres://mudatex:mudatex@localhost:5432/mudatex_e2e';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false, // the till is a shared resource: one register, one open session
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // The service worker would answer requests the tests intercept (for example the sign-in settings), so it is off except in the offline-till tests.
  use: { baseURL: 'http://localhost:4173', serviceWorkers: 'block', trace: 'retain-on-failure', launchOptions: { executablePath } },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } } },
    { name: 'phone', testMatch: 'responsive.spec.ts', use: { ...devices['Pixel 7'], launchOptions: { executablePath } } },
  ],
  webServer: [
    {
      command: 'node e2e/mock-supabase.mjs',
      url: 'http://localhost:3200/__stats',
      reuseExistingServer: false,
      env: { AUTH_DEV_SECRET: 'e2e-dev-secret-e2e-dev-secret-0001' },
    },
    {
      // Reset + migrate + bootstrap, then serve the built API. The API must be built first (npm run build in apps/api).
      command: 'node e2e/prepare.mjs && node ../api/dist/index.js',
      url: 'http://localhost:3100/ready',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATABASE_URL, PORT: '3100', NODE_ENV: 'development', DEV_TOKEN_ENDPOINT: 'true',
        AUTH_DEV_SECRET: 'e2e-dev-secret-e2e-dev-secret-0001', SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), CORS_ORIGINS: 'http://localhost:4173', RATE_LIMIT_MAX: '100000',
      },
    },
    {
      command: 'npm run build && npm run preview -- --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_API_URL: 'http://localhost:3100' },
    },
  ],
});
