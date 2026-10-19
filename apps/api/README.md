# Mudatex API

Phase 1 foundation (organization hierarchy, scoped IAM, audit log, product catalogue with units) and the Phase 2 inventory ledger (receipts, issues, reservations, transfers, roll splitting, maker-checker adjustments). See [ADR 004](../../docs/adr/004-inventory-ledger.md). TypeScript, Fastify, PostgreSQL 16. See [ADR 001](../../docs/adr/001-backend-framework-and-database.md).

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

All inventory commands require an `Idempotency-Key` header (8-128 characters). Retrying with the same key and body returns the original response (`Idempotent-Replayed: true`); the same key with a different body is rejected.

## Not built yet

POS, offline sync, procurement, cycle counts, accounting, manufacturing, payment adapters, notifications outbox, migration tooling, and the Flutter/web clients. No stock valuation exists: the costing method (ADR 005) is undecided. The identity provider has not been chosen; token verification is provider-agnostic JWKS.
