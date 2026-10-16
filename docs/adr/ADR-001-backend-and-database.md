# ADR-001: Initial API and database foundation

- **Status:** Accepted for Phase 1 foundation; revisit after the vertical-slice evaluation.
- **Date:** 2026-10-14
- **Decision owner:** Engineering, with business/security review required before production.

## Context

Mudatex requires atomic inventory operations, multi-entity records, accounting invariants, migration reconciliation and reliable concurrency. Sakash is a Flutter client backed by Firebase/Firestore and Supabase functions. Those patterns are useful references for customer-facing and POS workflows but should not dictate the new enterprise system's authoritative transaction model.

## Decision

Start with a TypeScript/NestJS modular-monolith API and PostgreSQL as the primary relational data store, using Prisma for typed schema access and versioned migrations. Keep business modules behind a versioned API. Do not split into microservices until measured needs justify it.

## Consequences

- Relational constraints and transactions are available for inventory and finance.
- The team must maintain migrations, integration tests and database operational practices.
- Identity provider, hosting, frontend framework, offline sync protocol, costing policy and payment providers remain open decisions.
- No production endpoint may accept privileged writes until server-side identity and scope authorization are implemented.
- Schema is a starting domain model; validate it with migration generation and database tests before treating it as deployable.

## Validation required

1. Run schema validation and migration against clean PostgreSQL 16.
2. Add integration tests for uniqueness, foreign keys, decimal quantity precision and immutable-ledger application services.
3. Test API health and graceful shutdown.
4. Review authorization design before enabling domain write endpoints.
