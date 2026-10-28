# Deployment and identity setup

**Recommended first production setup, step by step: [GO_LIVE.md](GO_LIVE.md)** (Vercel for the web console and API, Supabase for the database and sign-in).

This describes how to run the Mudatex API and connect an identity provider. Nothing here has been run against a real cloud account: the API image is built by CI but has not been deployed anywhere by this project.

## Running locally

```bash
docker compose up --build      # PostgreSQL, one-off migration, API on :3000
```

`docker-compose.yml` is for development only. It enables the shared development token secret, which the API refuses to use when `NODE_ENV=production`.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV` | yes | `production` for any real deployment |
| `DATABASE_URL` | yes | PostgreSQL connection string. Behind a hosted pooler use its **session** mode |
| `CRON_SECRET` | no | Serverless hosting only: turns on `GET /internal/cron/worker`, which Vercel's scheduler calls on a schedule (daily on the free plan, every minute on Pro) to deliver webhooks and tidy up (send it as `Authorization: Bearer <secret>`) |
| `DATABASE_SSL_CA` | no | The hosted database's certificate authority (PEM text), to verify TLS. `\n` is accepted for line breaks |
| `PORT` | no | default 3000 |
| `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE` | production | token verification; see the provider sections below |
| `AUTH_DEV_SECRET` | dev/test only | HS256 secret, 32+ characters. **Refused in production.** |
| `CORS_ORIGINS` | no | comma-separated browser origins allowed to call the API. Empty = none |
| `RATE_LIMIT_MAX` | no | requests per minute per client address, default 600 |
| `STAFF_MFA` | no | `required` makes staff sign in with an authenticator-app code as well as a password; default `off`. See `TWO_STEP_SIGN_IN.md` before turning it on |
| `TRUST_PROXY` | no | `true` only behind a trusted reverse proxy, so client addresses come from `X-Forwarded-For` (otherwise everyone shares the proxy's address and one limit) |
| `BODY_LIMIT_BYTES` | no | default 1,048,576 |
| `DB_POOL_MAX` | no | default 10 |
| `DB_STATEMENT_TIMEOUT_MS` | no | cancel any statement longer than this, default 20,000 |
| `DB_IDLE_IN_TX_TIMEOUT_MS` | no | close a session left idle inside a transaction, default 30,000 |

Keep secrets in your platform's secret store. Never commit them.

## The web console

`apps/web` builds to static files served by nginx (`apps/web/Dockerfile`, listens on 8080, runs as a non-root user). One setting at container start controls where it talks to the API:

| Variable | Meaning |
|---|---|
| `API_URL` | Public address of the API, such as `https://api.example.com`. Required. |
| `SUPABASE_URL` | The Supabase project address, `https://<project-ref>.supabase.co`. Set together with the next one to turn on password sign-in; leave both empty for the development sign-in. |
| `SUPABASE_PUBLISHABLE_KEY` | The project's **publishable (anon) key** from Project Settings, API Keys. It is meant to be public. The container refuses a key that looks like a secret one (`sb_secret_…`, `service_role`). |

They are written to `config.js` and into the browser content-security policy (`connect-src`), so the page can only talk to the API and the Supabase project. The container refuses to start with an invalid combination.

On the API side, add the console's address to `CORS_ORIGINS`. The console sends the access token as a bearer header, keeps it in the tab's `sessionStorage` (closing the tab signs out), refreshes it a minute before it expires, and uses no cookies. Serve it over HTTPS in production.

## Release steps

1. Build the image: `docker build -t mudatex-api apps/api`.
2. Run migrations **before** starting the new version, as a one-off job: `node dist/migrate-cli.js`. It is safe to run repeatedly and refuses to run if an applied migration file was edited.
3. Start the API. `GET /health` is liveness (the process is up). `GET /ready` is readiness: it returns 503 until the database answers and every migration is applied, so a load balancer holds traffic off a version that is ahead of its schema.
4. Create the first administrator once: `node dist/bootstrap-cli.js "<organization>" "<idp subject>" "<email>" "<name>"`. This is the only way to create an administrator without an existing one; it is not an HTTP endpoint.

Migrations are forward-only. A bad migration is fixed with a new migration. Take a database backup before every production migration; backup and restore policy (RPO/RTO) is an open decision (ADR 009).

## How authentication works

The API trusts a bearer JWT only if its signature verifies against the identity provider's published keys, it names an issuer and audience you configured, it has an expiry, and it has a subject (`sub`). The `sub` must match a user created in Mudatex (`users.external_subject`); a valid token for an unknown person gets 401, and a suspended user gets 403. No passwords are stored by Mudatex.

### Option A: Firebase Authentication

You already use Firebase for PFB. In a **new** Firebase project for Mudatex (do not share PFB's project):

1. Enable the sign-in methods you want (email/password, Google). For staff, prefer enforcing multi-factor authentication.
2. Set:
   ```
   AUTH_JWKS_URL=https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com
   AUTH_ISSUER=https://securetoken.google.com/<firebase-project-id>
   AUTH_AUDIENCE=<firebase-project-id>
   ```
3. Clients send the Firebase **ID token** (`await user.getIdToken()`) as `Authorization: Bearer <token>`.
4. A user's `sub` is the Firebase UID. Create their Mudatex user with that value as `externalSubject`.

### Option B: Supabase Auth (the console's sign-in is built for this)

Project: `https://xdgjomvsbjldmejwwoyb.supabase.co`.

1. **Signing keys.** In the Supabase dashboard, Project Settings, JWT Keys: use an asymmetric key (ES256 or RS256), so the API can verify tokens from the public key set. A project that still signs with the legacy shared secret (HS256) is not supported; rotate to an asymmetric key first. The API's token check is tested against ES256 key sets, including wrong issuer, wrong audience, expired, unknown key, shared-secret and unsigned tokens.
2. **API settings:**
   ```
   AUTH_JWKS_URL=https://xdgjomvsbjldmejwwoyb.supabase.co/auth/v1/.well-known/jwks.json
   AUTH_ISSUER=https://xdgjomvsbjldmejwwoyb.supabase.co/auth/v1
   AUTH_AUDIENCE=authenticated
   ```
3. **Who may have an account.** Authentication, Sign In / Providers, Email: switch **off** "Allow new users to sign up", so only people you invite exist. Turn on multi-factor authentication for staff when you are ready (the console does not prompt for a second factor yet).
4. **Links in emails.** Authentication, URL Configuration: set the Site URL to the console's address and add it to the redirect URLs. Invitation and password-reset emails send people there, and the console lets them choose a password.
5. **Web container:** set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` as above.
6. **People.** A person has two records that must agree: the Supabase account and the Mudatex user whose `externalSubject` equals the Supabase **user id** (a UUID, shown in Authentication, Users). Invite them in Supabase first, then create the Mudatex user with that id. Someone who signs in successfully but has no Mudatex user sees "you have not been set up in Mudatex yet".
7. **First administrator.** Invite yourself in Supabase, copy your user id, then run `node dist/bootstrap-cli.js "<organization>" "<your Supabase user id>" "<your email>" "<your name>"` (see Release steps).

### Both providers

- Add the same CORS origin as your web app to `CORS_ORIGINS`.
- Disabling a person in the provider stops new tokens, but a token already issued stays valid until it expires. For immediate removal, also suspend the user in Mudatex (`POST /v1/users/:id/suspend`), which takes effect on the next request.
