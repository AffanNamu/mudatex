# Implementation Status

## Implemented in the foundation branch

- NestJS API scaffold with versioned \`/api/v1\`, Helmet, strict validation and health/readiness endpoints.
- PostgreSQL/Prisma schema and migrations for organizations, legal entities, locations, units, textile product metadata, inventory movements, audit events, idempotency and memberships.
- OIDC token verification and server-side organization membership scope guard. Identity provider configuration and secure membership provisioning remain operational prerequisites.
- Product catalog: \`GET /api/v1/products\`, \`POST /api/v1/products\`, and \`POST /api/v1/products/:id/activate\`. Product creation/activation are organization-scoped, role-protected and audited transactionally.
- Inventory receipts: \`POST /api/v1/inventory/receipts\`; active product/location checks, same-entity constraint, positive decimal quantity, scoped idempotency and transactional audit.
- Inventory transfers: \`POST /api/v1/inventory/transfers\`; paired TRANSFER_OUT/TRANSFER_IN movements, source-availability check, distinct locations, same legal entity, serializable transaction and audit trail.
- Stock balances: \`GET /api/v1/inventory/balances\` derives on-hand quantities from the movement ledger, with optional location/product filters. This is a quantity view, not financial valuation.
- Inventory write operations require valid OIDC authentication, active organization membership and OWNER/ADMIN/MANAGER/STAFF role; VIEWER is read-only.
- Unit tests cover core product, receipt, transfer and authorization cases. Local PostgreSQL, CI, environment template, ADRs and Sakash reference mapping are present.

## Not yet implemented

- Secure login/user provisioning and granular branch/warehouse permissions.
- Product update/archive, variants, barcodes, price lists and richer textile attributes.
- Cycle counts, controlled stock adjustments, returns, transfer dispatch/receipt workflow, reservations and optimized persisted balance projections.
- Procurement, POS, wholesale orders, customer/supplier management, accounting, taxes, payments and full manufacturing execution.
- Offline sync protocol, conflict resolution and device registration.
- Inventory costing/valuation policy and official financial postings.
- Production deployment, monitoring, backup/DR automation, runbooks and legacy import/reconciliation.

## Verification status

Transfer and balance changes require successful CI schema validation, migrations, typecheck, tests and build before merge/deployment. No production deployment or production-data migration has occurred.
