# ADR 020 — First production hosting: Vercel and Supabase

**Status:** Proposed (implemented; not yet run on the real platforms)
**Decision owner:** Product owner (chose Vercel and Supabase), engineering lead

## Context

The owner chose Supabase for the database and sign-in, and Vercel for hosting. The API was written as a long-running
server with an in-process delivery worker.

## Decision

- **Web console** on Vercel as a static site. Settings and the content-security policy are written at build time
  (`apps/web/scripts/write-runtime-config.mjs`), because a static host cannot fill them in per request.
- **API** on Vercel as one Node function: `apps/api/api/index.js` re-exports `src/vercel.ts`, which builds the same
  Fastify server once per warm instance and passes requests to it. No code path is specific to Vercel except that file
  and the scheduler route.
- **Delivery worker** becomes `GET /internal/cron/worker`, guarded by `CRON_SECRET`, called every minute by Vercel
  Cron. One call runs delivery passes for up to 45 seconds and then does housekeeping. Several overlapping calls are
  safe (the database arbitrates with `SKIP LOCKED`).
- **Migrations** run in the production build (`scripts/vercel-release.mjs`), only for `VERCEL_ENV=production`. A failed
  migration fails the deployment. Previews never touch the database.
- **Database:** Supabase's **session** pooler with a small pool per instance. Per-connection timeouts use `SET`, not
  start-up parameters. `DATABASE_SSL_CA` verifies TLS. Every migration run enables row-level security on every table
  and removes the public roles' privileges, so Supabase's public API cannot expose Mudatex data.
- The Dockerfiles stay: the same code runs unchanged on any always-on container host.

## Consequences

- Vercel Pro is required (commercial use; per-minute cron).
- The rate limiter's counters live in each instance's memory, so the limit is per instance. It slows abuse; it is not
  a global cap. Moving counters to the database or a cache is possible if needed.
- Webhook deliveries can lag by up to a minute.
- Connections: instances × pool size must stay below the pooler's client limit. Pilot scale is far below it. At larger
  scale, switch the API to an always-on host, or move queries to Supabase's transaction pooler after replacing
  session-level settings with per-transaction ones.
- Function cold starts add a delay to the first request after idle; Fluid compute reuses warm instances.
- Not verified here: this sandbox cannot reach Vercel or Supabase. The function is exercised through a plain Node
  HTTP server in tests (probes, JSON bodies, scheduler authentication, misconfiguration), and the web build step is
  tested and run in CI. The first real deployment is the proof.

## Revisit trigger

First live run; any connection-limit errors; webhook latency complaints; need for a global rate limit.
