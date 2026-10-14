# Mudatex Enterprise Platform

A new enterprise platform for international textile retail, wholesale, distribution, integrated accounting and full manufacturing. Sakash Collection is a workflow and migration reference, not a runtime dependency or the codebase being extended.

## Current implementation

The active foundation branch introduces a NestJS API, PostgreSQL/Prisma data model, health/readiness endpoints, local PostgreSQL development service and initial CI. Domain write APIs are intentionally not exposed until server-side identity and scoped authorization are in place.

- [Enterprise architecture and requirements](docs/ENTERPRISE_ARCHITECTURE_AND_SPECIFICATION.md)
- [Sakash reference map](docs/SAKASH_REFERENCE_MAP.md)
- [Implementation status](docs/IMPLEMENTATION_STATUS.md)
- [Architecture decision register](docs/adr/README.md)
- [ADR-001: backend and database](docs/adr/ADR-001-backend-and-database.md)

## Local development

Prerequisites: Node.js 22+, npm, Docker Compose.

1. Copy `.env.example` to `.env` and keep local credentials out of Git.
2. Start PostgreSQL with `docker compose up -d postgres`.
3. Install dependencies: `npm install`.
4. Validate and generate Prisma client: `npx prisma validate` then `npx prisma generate`.
5. Run tests and checks: `npm test`, `npm run typecheck`, `npm run build`.
6. Start the API with `npm run start:dev`.
7. Liveness endpoint: `GET /api/v1/health/live`; readiness endpoint: `GET /api/v1/health/ready`.

The first schema draft does not yet include a reviewed production migration. Do not connect this scaffold to production data. Generate and test versioned migrations before running domain workflows.

## Guardrails

- PostgreSQL is the proposed authoritative transactional database; major decisions remain subject to ADR review and CI evidence.
- Inventory costing is undecided and must not be hard-coded.
- Never trust client-side admin flags or client-reported payment success.
- All inventory/finance writes must be server-authorized, transactional, idempotent and auditable.
- Offline actions must have explicit accepted/rejected/review states and conflict handling.
- During Sakash migration, use one authoritative writer per inventory/finance domain.
- Development uses synthetic data only; never commit real credentials, signing materials or production data.

## Important

The specification describes the intended platform. Features marked not implemented in the status document are not yet available. CI has been authored but must pass before this branch is merged or treated as deployable.
