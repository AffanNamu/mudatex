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
- Organization-scoped inventory receiving API:
  - `POST /api/v1/inventory/receipts` records a positive receipt quantity against an active product and active stock-bearing location within the selected organization.
  - Product and location must belong to the same active legal entity; receipt quantities use the product's base unit because unit conversion is not yet implemented.
  - Inventory movements are append-only; the receipt and its audit event are created in one database transaction.
  - An organization-scoped idempotency key prevents duplicate receipts on retries and rejects reuse of the same key with a different payload, including concurrent unique-key races.
  - OWNER, ADMIN, MANAGER and STAFF may receive inventory; VIEWER is read-only. All access still requires a valid OIDC token and active organization membership.
- Unit tests for health endpoints, product-role authorization, product creation scope/UOM checks, inventory receipt validation, idempotent retries and inventory write-role authorization.
- Local PostgreSQL Docker Compose service, environment template, CI workflow, architecture decision record and Sakash reference map.

## Not yet implemented

- Login/user provisioning workflow, production identity-provider configuration, branch/warehouse/legal-entity granular permissions and role administration.
- Product activation/update/archive, categories/variants/barcodes/pricing, attachments and richer textile-specific attributes.
- Inventory transfers/counts/adjustments/returns, stock ledger balance projections, reservations and availability logic.
- Procurement, POS, wholesale orders, customer/supplier management, integrated accounting, tax, payments and full manufacturing execution.
- Offline synchronization protocol, conflict resolution and device registration.
- Inventory costing policy and official valuation/production financial postings.
- Production deployment, monitoring, backups, disaster-recovery automation and operational runbooks.
- Legacy data export/import scripts and parallel-run reconciliation.

## Verification status

CI passed for the preceding product-catalog head. The inventory-receiving change must pass schema validation, migrations, typecheck, tests and production build before it is considered verified or merged. No production deployment or production-data migration has been performed.
