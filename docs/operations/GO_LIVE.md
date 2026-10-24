# Going live: Vercel (web console and API) + Supabase (database and sign-in)

Two Vercel projects from this one repository, and your Supabase project. Nothing here needs coding. You copy a few
values between dashboards. Allow about an hour.

| Piece | Where it runs | Rough cost (check current prices) |
|---|---|---|
| Web console | Vercel project 1, root folder `apps/web` | Part of Vercel Pro |
| API | Vercel project 2, root folder `apps/api` (one serverless function, Fluid compute) | Part of Vercel Pro |
| Database + sign-in | Supabase project `xdgjomvsbjldmejwwoyb` (Frankfurt) | Free to test. **Pro (about $25/month) before real use**: the free plan pauses after a week of inactivity and has no point-in-time recovery. |

**Vercel plan:** use **Pro** (about $20 per user per month). The free Hobby plan is for non-commercial use only, and it
also cannot run the every-minute scheduler the API needs for webhook deliveries.

**What is different about running the API on Vercel** (see ADR 020): it runs as a function, not a server that stays on.
So (1) webhook deliveries and housekeeping run when Vercel's scheduler calls the API once a minute, not continuously;
(2) the request-rate limit is counted per running instance, so it is a speed bump rather than a hard cap; (3) each
instance keeps a few database connections, so it uses Supabase's *session* pooler with a small pool. For a pilot with
tens of users this is comfortable. If you outgrow it, the same code runs in a container on a host that stays on (the
Dockerfiles are kept for that).

## Part A. Supabase

1. **Database connection.** Dashboard, your project, **Connect**, choose **Session pooler**. Copy the string, which
   looks like
   `postgres://postgres.xdgjomvsbjldmejwwoyb:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`.
   Replace `[YOUR-PASSWORD]` with the database password (reset it under Project Settings, Database, if needed). If the
   password has symbols like `@`, `/` or `#`, use their percent codes (`%40`, `%2F`, `%23`) or pick a password of
   letters and digits only. Use port **5432** (session), never 6543. Keep this string private.
2. **Certificate.** Project Settings, Database, **SSL Configuration**: download the certificate and open it in a text
   editor; you will paste all of it into Vercel. (Fallback: add `?sslmode=no-verify` to the end of the connection
   string. The link is encrypted but the server's identity is not checked.)
3. **Switch off the built-in data API:** Project Settings, Data API. Mudatex never uses it. As a second layer, every
   migration run turns on row-level security for all tables and removes access from Supabase's public roles.
4. Already done: asymmetric signing key (ECC P-256), sign-ups off.

## Part B. The API on Vercel

5. Vercel, **Add New, Project**, import the GitHub repository `AffanNamu/mudatex`. Set **Root Directory** to
   `apps/api`. Leave the framework as detected ("Other"); `apps/api/vercel.json` sets the rest.
6. Before the first deploy, add **Environment Variables** and tick **Production only** for each (so preview builds
   never touch your database):

   | Name | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | the session-pooler string from step 1 |
   | `DATABASE_SSL_CA` | the certificate text from step 2 (omit if you used `sslmode=no-verify`) |
   | `DB_POOL_MAX` | `5` |
   | `TRUST_PROXY` | `true` |
   | `AUTH_JWKS_URL` | `https://xdgjomvsbjldmejwwoyb.supabase.co/auth/v1/.well-known/jwks.json` |
   | `AUTH_ISSUER` | `https://xdgjomvsbjldmejwwoyb.supabase.co/auth/v1` |
   | `AUTH_AUDIENCE` | `authenticated` |
   | `SECRETS_ENCRYPTION_KEY` | a new random key: run `openssl rand -base64 32` and paste the result. **Back it up**: stored webhook secrets cannot be read without it. |
   | `CRON_SECRET` | a long random string (for example `openssl rand -hex 32`). Vercel's scheduler sends it with every call. |
   | `CORS_ORIGINS` | `https://placeholder.invalid` for now (step 9 fixes it) |

7. **Deploy.** The build compiles the API and, for production, applies the database migrations first. If a migration
   fails, the deployment fails and nothing changes. Watch the build log for `Applied: 0001_…`.
8. Note the API address Vercel shows (for example `https://mudatex-api.vercel.app`). Check
   `https://<api address>/ready`: it should show `"ready":true`.

## Part C. The web console on Vercel

9. **Add New, Project**, import the same repository again, **Root Directory** `apps/web`. Environment variables
   (Production only):

   | Name | Value |
   |---|---|
   | `API_URL` | the API address from step 8 |
   | `SUPABASE_URL` | `https://xdgjomvsbjldmejwwoyb.supabase.co` |
   | `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_XRti9MZZYb8tTAlFIzzGCg_i6u9mBNu` |

   Deploy. Note the web address (for example `https://mudatex.vercel.app`).
10. Back in the **API** project, set `CORS_ORIGINS` to the **web** address (no trailing slash) and **redeploy** so it
    takes effect. (Vercel settings apply to new deployments.)

## Part D. Connect sign-in and create your administrator

11. Supabase, Authentication, **URL Configuration**: Site URL = the web address; add it to Redirect URLs.
12. Create your administrator in Mudatex. From your computer, with this repository checked out and Node 22 installed:
    ```
    cd apps/api && npm ci && npm run build
    DATABASE_URL='<the session-pooler string>' DATABASE_SSL_CA="$(cat supabase-ca.crt)" \
      node dist/bootstrap-cli.js "<organization name>" "fa46a6c6-f214-428c-a633-20573ae9f0f5" "<your email>" "<your name>"
    ```
    (`supabase-ca.crt` is the certificate from step 2. The id is your Supabase user id. Use the email that account
    signs in with.) Send me the organization name, email and name and I will write the exact line for you.
13. Open the web address, enter your email, and either type your password or use **Forgot your password?** to get a
    reset link by email. You should land on a welcome page with every menu item.

## Part E. Add people

For each person: (1) Supabase, Authentication, Users, **Invite user**; (2) in Mudatex, People & access, create their
user with the **Supabase user id** shown for them; (3) give them a role scoped to their company, country or shop. They
open the invitation link, choose a password, and sign in.

## Checks after go-live

- `/ready` is true on the API; the web page loads over https; sign-in works, and a wrong password says "Wrong email or
  password."
- Vercel, API project, **Settings, Cron Jobs** shows the every-minute job; its log shows 200 responses.
- A request with the publishable key to `https://xdgjomvsbjldmejwwoyb.supabase.co/rest/v1/users` returns nothing or an
  error, never rows.
- Upgrade Supabase to Pro and note its backup schedule before entering real data. Decide your recovery targets
  (ADR 009).

## Everyday operations

- **Release:** merge to `main`. Vercel builds both projects; the API build applies migrations before the new version
  takes traffic. Every pull request gets a preview of the web console (it still talks to the production API, so use
  test accounts) and a preview of the API that does **not** touch the database unless you give Preview its own
  database settings.
- **Roll back:** Vercel, Deployments, **Instant Rollback**. Migrations only go forward; a bad one is fixed with a new
  migration.
- **Secrets:** change them only in the dashboards; none are in the repository.
