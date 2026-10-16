# Implementation Status

## Implemented in the foundation branch

- NestJS API scaffold with a versioned `/api/v1` prefix, Helmet security headers, strict request validation and health/readiness endpoints.
- PostgreSQL/Prisma schema and versioned migrations for organizations, legal entities, locations, units of measure, textile product metadata, inventory movement primitives, audit events, idempotency records and organization memberships.
- OIDC access-token verification foundation and server-side organization membership scope guard. Identity-provider configuration and membership provisioning remain operational prerequisites.
- Organization-scoped product catalog API:
  - `GET /api/v1/products` lists products only for active legal entities belonging to the selected organization.
  - `POST /api/v1/products` creates a draft product for an active legal entity in that organization.
  - Product creation normalizes SKU, validates active unit of measure and legal-entity scope, records an audit event transactionally, and handles SKU uniqueness conflicts.
  - Product writes require OWNER, ADMIN or MANAGER organization membership. STAFF and VIEWER are read-only for this operation.
- Unit tests for health endpoints, product-role authorization and product creation tenant/UOM checks.
- Local PostgreSQL Docker Compose service, environment template, CI workflow, architecture decision record and Sakash reference map.

## Not yet implemented

- Login/user provisioning workflow, production identity-provider configuration, branch/warehouse/legal-entity granular permissions and role administration.
- Product updates/archive, categories/variants/barcodes/pricing, attachments and richer textile-specific attributes.
- Inventory receipt/transfer/count workflows, stock ledger balance projections and reservation/availability logic.
- Procurement, POS, wholesale orders, customer/supplier management, integrated accounting, tax, payments and full manufacturing execution.
- Offline synchronization protocol, conflict resolution and device registration.
- Inventory costing policy and official valuation/production financial postings.
- Production deployment, monitoring, backups, disaster-recovery automation and operational runbooks.
- Legacy data export/import scripts and parallel-run reconciliation.

## Verification status

The foundation CI run after the Prisma service injection fix passed. Product-catalog changes have triggered new CI runs; verify the latest head SHA and require schema validation, migrations, typecheck, tests and production build to pass before merge. No production deployment or production-data migration has been performed.
