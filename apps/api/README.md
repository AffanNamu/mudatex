# Mudatex API

Phase 1 foundation (organization hierarchy, scoped IAM, audit log, product catalogue with units) the Phase 2 inventory ledger (receipts, issues, reservations, transfers, roll splitting, maker-checker adjustments), retail POS with pricing and tax (registers, sessions, sales, payments, returns), procurement (suppliers, purchase orders, receiving, supplier returns), the general ledger core (chart of accounts, fiscal periods, approved exchange rates, maker-checker journals, reversals, trial balance), and manufacturing (versioned BOMs with routing, work orders, material reservation, issue and return, output, quality holds, reconciliation, genealogy). See [ADR 004](../../docs/adr/004-inventory-ledger.md) and [ADR 012](../../docs/adr/012-pos-pricing-tax-and-payments.md) [ADR 013](../../docs/adr/013-procurement.md) and [ADR 014](../../docs/adr/014-general-ledger-core.md) and [ADR 015](../../docs/adr/015-manufacturing-and-quality-holds.md). TypeScript, Fastify, PostgreSQL 16. See [ADR 001](../../docs/adr/001-backend-framework-and-database.md).

See [deployment and identity setup](../../docs/operations/DEPLOYMENT_AND_IDENTITY.md) for environment variables, the release steps, health probes and Firebase/Supabase configuration.

## Run locally

```bash
cd apps/api
cp .env.example .env            # then export the variables, or use your shell's env loader
npm ci
DATABASE_URL=postgres://... npm run migrate
DATABASE_URL=postgres://... npm run bootstrap -- "Mudatex Group" <idp-subject> admin@example.com "Admin Name"
npm run dev
```

`bootstrap` is the only way to create the first administrator; it is deliberately not an HTTP endpoint.

## Test

Tests run against a real PostgreSQL database and **drop and recreate its `public` schema**, so point them only at a disposable database.

```bash
TEST_DATABASE_URL=postgres://mudatex:mudatex@localhost:5432/mudatex_test npm test
```

## Authorization model

- Hierarchy: organization (group) → legal entity → location tree. Country is an attribute of legal entities and locations.
- A membership grants a role over one scope: `group`, `country`, `legal_entity` or `location`. A location grant covers its descendants.
- Every protected call checks the caller's active, unexpired, unrevoked memberships on the server. List endpoints are filtered to granted scopes.
- Organization-wide actions (creating legal entities, roles, users, catalogue writes) need a group-scope grant.
- Granting access requires `iam.manage` over the target scope, forbids self-grants, and forbids granting permissions the grantor does not hold over that scope.
- Authentication: bearer JWTs verified against the identity provider's JWKS in production. The HS256 development secret is rejected when `NODE_ENV=production`.

## Endpoints (`/v1`)

| Area | Endpoints |
|---|---|
| Identity | `GET /me`, `POST /users`, `POST /users/:id/suspend`, `POST /roles`, `POST /memberships`, `DELETE /memberships/:id` |
| Organization | `POST/GET /legal-entities`, `POST/GET /locations` |
| Catalogue | `POST/GET /units`, `POST/GET /products`, `POST /products/:id/archive` |
| Audit | `GET /audit-log` |
| Inventory commands | `POST /inventory/receipts`, `/issues`, `/rolls/:lotId/split`, `/reservations`, `/reservations/:id/fulfil`, `/reservations/:id/release`, `/transfers`, `/transfers/:id/receive`, `/transfers/:id/cancel`, `/adjustments`, `/adjustments/:id/approve`, `/adjustments/:id/reject` |
| Inventory reads | `GET /inventory/balances`, `/movements`, `/lots`, `/reservations/:id`, `/transfers/:id`, `/adjustments/:id`, `/reconciliation` |

| Pricing | `POST/GET /pricing/tax-codes`, `POST /pricing/price-lists`, `PUT/GET /pricing/price-lists/:id/items` |
| POS | `POST /pos/registers`, `POST /pos/registers/:id/sessions`, `GET /pos/registers/:id/price`, `POST /pos/sessions/:id/close`, `GET /pos/sessions/:id/report`, `POST/GET /pos/sales`, `GET /pos/sales/:id`, `POST /pos/sales/:id/cancel`, `POST /pos/payments/:id/verify`, `POST /pos/payments/:id/fail`, `POST /pos/sales/:id/returns`, `GET /pos/returns/:id`, `POST /pos/returns/:id/disburse` |

| Procurement | `POST/GET /procurement/suppliers`, `POST /procurement/suppliers/:id/block\|unblock`, `POST/GET /procurement/purchase-orders`, `PUT/GET /procurement/purchase-orders/:id`, `POST .../:id/submit\|approve\|reject\|cancel\|close`, `POST .../:id/receipts`, `POST .../:id/returns`, `GET /procurement/on-order` |
| Accounting | `POST/GET /accounting/accounts`, `POST /accounting/accounts/:id/archive`, `PUT /accounting/settings/:legalEntityId`, `POST/GET /accounting/periods`, `POST .../periods/:id/close\|reopen`, `POST/GET /accounting/exchange-rates`, `POST .../exchange-rates/:id/approve\|reject`, `POST/GET /accounting/journals`, `PUT/DELETE/GET /accounting/journals/:id`, `POST .../journals/:id/post\|reverse`, `GET /accounting/trial-balance`, `GET /accounting/accounts/:id/ledger` |
| Manufacturing | `POST/GET /manufacturing/work-centres`, `POST/GET/PUT /manufacturing/boms`, `POST .../boms/:id/approve\|retire`, `GET /manufacturing/requirements`, `POST/GET /manufacturing/work-orders`, `POST .../work-orders/:id/release\|cancel\|issues\|returns\|outputs\|complete\|close`, `POST .../work-orders/:id/operations/:opNo/start\|complete`, `GET .../work-orders/:id/reconciliation`, `GET /manufacturing/genealogy` |
| Quality | `POST /quality/lots/:id/hold\|release` |
| Posting rules | `PUT/GET /accounting/posting-rules/:legalEntityId/pos`, `POST .../posting-rules/:legalEntityId/backfill`, `GET /accounting/posting-log`, `POST /accounting/posting-log/:sourceType/:sourceId/retry` |
| Integrations | `POST/GET /integrations/webhooks`, `POST .../webhooks/:id/pause\|resume\|disable\|rotate-secret\|test`, `GET /integrations/deliveries`, `POST .../deliveries/:id/retry`, `GET /integrations/events` |

See [events and webhooks](../../docs/operations/EVENTS_AND_WEBHOOKS.md).

All inventory, POS, procurement, accounting and manufacturing commands require an `Idempotency-Key` header (8-128 characters). Retrying with the same key and body returns the original response (`Idempotent-Replayed: true`); the same key with a different body is rejected.

## Migration from Sakash

`node dist/migration/sakash-cli.js <profile|plan|import|reconcile>`; see [the runbook](../../docs/migration/SAKASH_MIGRATION.md).

## Not built yet

Offline POS and sync, payment-provider adapters, automatic journal postings from POS and procurement, receivables/payables, bank reconciliation, financial statements, year-end close, requisitions, cycle counts, manufacturing costing and multi-level MRP, payment adapters, notifications outbox, migration tooling, and the Flutter/web clients. No stock valuation exists: the costing method (ADR 005) is undecided. The identity provider has not been chosen; token verification is provider-agnostic JWKS.
