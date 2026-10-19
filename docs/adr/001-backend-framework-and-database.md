# ADR 001 — Backend framework and primary database

- **Status:** Proposed (implemented in Phase 1 foundations; validate with the Phase 0 spike before building further modules on it)
- **Decision owner:** Engineering lead, with owner (AffanNamu) confirmation
- **Date:** 2026-10-19

## Context and business drivers
Inventory, finance and manufacturing need atomic multi-row transactions, relational integrity and concurrent-posting control. The team already works in Dart/Flutter on the client, and PFB's backend is Firestore plus Supabase functions, which the owner chose not to carry forward.

## Options considered
1. **TypeScript + Fastify + PostgreSQL** (chosen for the foundation).
2. NestJS + PostgreSQL: more structure and conventions, more framework surface.
3. Dart backend (Shelf/Serverpod) + PostgreSQL: shares language with Flutter, smaller ecosystem for auth, migrations and ops tooling.
4. Stay on Firestore/Supabase: rejected, see the [feature map](../PFB_TO_MUDATEX_FEATURE_MAP_AND_ROADMAP.md).

## Decision and rationale
PostgreSQL 16 as the single transactional store. A TypeScript modular monolith on Fastify with plain SQL migrations (checksummed, applied in order, edits to applied files refused) and `pg` for data access, so SQL, transactions and locks stay explicit for ledger work. Zod validates request shapes. Authorization lives in one module and runs inside the same transaction as the change it protects.

## Consequences and trade-offs
- Two languages across the product (TypeScript server, Dart clients). OpenAPI-generated Dart clients can reduce drift; not yet set up.
- No ORM: more SQL to write and review, fewer hidden queries.
- A modular monolith defers service splitting until scaling or ownership requires it.

## Security / reliability / migration impact
Scoped IAM and an append-only audit log are in the first migration set. Secrets scanning is a required CI job. Production refuses the development token secret.

## Evidence and tests
`apps/api/test`: cross-scope and cross-organization denial, revocation and expiry, privilege-escalation prevention, audit immutability and rollback, migration idempotency and tamper refusal. A mutation check (disabling scope matching) fails three of these tests.

## Revisit trigger
The Phase 0 spike finds a blocking transaction, offline-sync or operations problem, or the team's skills favour another stack.
