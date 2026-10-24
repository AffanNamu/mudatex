# Going live: Supabase (database and sign-in) + Render (API and web console)

This is the recommended first production setup. Nothing here needs coding. You will copy a few values between two
dashboards. Allow about an hour.

| Piece | Where it runs | Rough cost (check current prices) |
|---|---|---|
| Database (PostgreSQL) | Supabase project `xdgjomvsbjldmejwwoyb`, Frankfurt | Free to test. **Pro (about $25/month) before real use**: the free plan pauses after a week of inactivity and has no point-in-time recovery. |
| Sign-in | Supabase Auth, same project | Included |
| API | Render web service, Frankfurt | Starter, about $7/month |
| Web console | Render web service (Docker), Frankfurt | Starter, about $7/month |

Why Render: it builds straight from this repository's Dockerfiles, keeps the API always on (the background worker for
webhooks runs inside it), runs database migrations before each release, and sits in the same region as the database.
Any host that runs Docker images works; `render.yaml` only saves you typing.

## Part A. Supabase

1. **Database connection.** Dashboard, your project, **Connect** (top bar), choose **Session pooler**. Copy the string.
   It looks like
   `postgres://postgres.xdgjomvsbjldmejwwoyb:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`.
   Replace `[YOUR-PASSWORD]` with the database password (reset it under Project Settings, Database if you do not have
   it). If the password contains symbols such as `@`, `/` or `#`, replace each with its percent code (`%40`, `%2F`, `%23`),
   or choose a password with letters and digits only.
   - Use the **session** pooler (port 5432). Do **not** use the transaction pooler (port 6543): the API relies on
     session features.
   - Keep this string private. It is the key to all your data.
2. **Certificate.** Project Settings, Database, **SSL Configuration**, download the certificate and open it in a text
   editor. You will paste its whole text into Render in step 7. (Fallback if you skip this: add `?sslmode=no-verify`
   to the end of the connection string. The link is still encrypted, but the server's identity is not checked.)
3. **Switch off the built-in data API.** Project Settings, Data API (or API), turn it off. Mudatex talks to the
   database directly and never needs it. As a second layer, every time the API runs migrations it turns on row-level
   security on all tables and removes access from Supabase's public roles, so the public keys cannot read your data
   even if the data API is switched on by mistake.
4. Already done: asymmetric signing key (ECC P-256), sign-ups off.

## Part B. Render

5. Create an account at render.com and connect your GitHub account. **New, Blueprint**, pick the repository
   `AffanNamu/mudatex`, branch `main`. Render reads `render.yaml` and proposes two services: `mudatex-api` and
   `mudatex-web`.
6. Render asks for the values marked "enter in the dashboard". For the first pass:

   | Service | Variable | Value |
   |---|---|---|
   | mudatex-api | `DATABASE_URL` | the session-pooler string from step 1 |
   | mudatex-api | `DATABASE_SSL_CA` | the certificate text from step 2 (leave empty if you used `sslmode=no-verify`) |
   | mudatex-api | `CORS_ORIGINS` | `https://placeholder.invalid` for now |
   | mudatex-web | `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_XRti9MZZYb8tTAlFIzzGCg_i6u9mBNu` |
   | mudatex-web | `API_URL` | `https://placeholder.invalid` for now |

7. Apply. Render builds both images. The API's first release runs the database migrations; if one fails, the release
   stops and the old version (none yet) keeps serving. Watch the logs for `Applied: 0001_…`.
8. Both services get an address, such as `https://mudatex-api.onrender.com` and `https://mudatex-web.onrender.com`
   (the exact names are shown on each service's page). Now fix the two placeholders:
   - `mudatex-api`: `CORS_ORIGINS` = the **web** address (no trailing slash)
   - `mudatex-web`: `API_URL` = the **API** address
   Render redeploys each when you save.
9. Check `https://<api address>/ready` shows `"ready":true`.
   Back up the API's `SECRETS_ENCRYPTION_KEY` (Environment tab) somewhere safe: without it, stored webhook secrets
   cannot be read.

## Part C. Connect sign-in to the web address

10. Supabase, Authentication, **URL Configuration**: Site URL = the web address; add it to Redirect URLs as well.
11. Create your administrator in Mudatex. Render, `mudatex-api`, **Shell**, run (all one line):
    ```
    node dist/bootstrap-cli.js "<organization name>" "fa46a6c6-f214-428c-a633-20573ae9f0f5" "<your email>" "<your name>"
    ```
    The id is your Supabase user id. Use the email that account signs in with.
12. Open the web address, enter your email, and either type your password or use **Forgot your password?** to get an
    email link (this needs step 10). You should land on a welcome page with every menu item.

## Part D. Add people

For each person: (1) Supabase, Authentication, Users, **Invite user** (their email); (2) in Mudatex, People & access,
create their user with the **Supabase user id** shown for them; (3) give them a role scoped to their company, country
or shop. They open the invitation link, choose a password, and sign in.

## Checks after go-live

- `/ready` is true on the API; the web page loads over https.
- Sign in works, and a wrong password gives "Wrong email or password."
- In Supabase, Table Editor shows the tables but a request with the publishable key to
  `https://xdgjomvsbjldmejwwoyb.supabase.co/rest/v1/users` returns nothing or an error, never rows.
- Upgrade Supabase to Pro and note the backup schedule before entering real data. Decide your recovery targets
  (ADR 009).

## Everyday operations

- **Release:** push to `main` (or click Manual Deploy). Render builds, runs migrations, and swaps versions only if they
  succeed.
- **Roll back code:** Render, Deploys, redeploy an earlier one. Migrations are forward-only; a bad migration is fixed
  with a new one.
- **Secrets:** change them only in the dashboards; none are in the repository.
