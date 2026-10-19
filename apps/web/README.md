# Mudatex web console

React + TypeScript + Vite. See [ADR 019](../../docs/adr/019-web-console.md) for the rules it follows (the browser never computes money; idempotency keys follow intent; permissions in the UI are a courtesy).

## Run it

```bash
# API with a development sign-in endpoint (never available in production)
cd apps/api && DATABASE_URL=... AUTH_DEV_SECRET=<32+ chars> DEV_TOKEN_ENDPOINT=true CORS_ORIGINS=http://localhost:5173 npm run dev
# Create a first administrator once:  npm run bootstrap -- "Acme" admin-1 admin@acme.test "Ada Admin"

cd apps/web && cp .env.example .env && npm install && npm run dev      # http://localhost:5173
```

Sign in with the administrator's email (development sign-in). To try real sign-in against a Supabase project, put its URL and publishable key in `public/config.js` (see `.env.example`) and give the API the project's `AUTH_*` settings; see the deployment guide.

## Checks

```bash
npm run typecheck
npm test            # unit tests
npm run e2e         # browser tests; needs `npm run build` in apps/api and a Postgres database named like *e2e*
```

`npm run e2e` resets the database named by `E2E_DATABASE_URL` (default `postgres://mudatex:mudatex@localhost:5432/mudatex_e2e`), refusing any name that does not contain "e2e" or "test". Set `PLAYWRIGHT_CHROMIUM_PATH` to use an already-installed Chromium instead of the one Playwright downloads.
