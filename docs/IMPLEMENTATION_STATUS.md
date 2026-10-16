# Implementation Status

## Implemented in the foundation branch

- NestJS API scaffold with versioned \`/api/v1\`, Helmet, strict validation and health/readiness endpoints.
- PostgreSQL/Prisma schema and migrations for organizations, legal entities, locations, units, textile product metadata, inventory movements, audit events, idempotency and memberships.
- OIDC token verification and server-side organization membership scope guard. Identity provider configuration and secure membership provisioning remain operational prerequisites.
- Product catalog: \`GET /api/v1/products\`, \`POST /api/v1/products\`, and \`POST /api/v1/products/:id/activate\`. Product creation/activation are organization-scoped, role-protected and audited transactionally.
- Inventory receipts: \`POST /api/v1/inventory/receipts\`; active product/location checks, same-entity constraint, positive decimal quantity, scoped idempotency and transactional audit.
- Legacy immediate inventory transfers remain available at \`POST /api/v1/inventory/transfers\` for compatibility; they post paired TRANSFER_OUT/TRANSFER_IN movements immediately. Prefer the controlled warehouse-transfer lifecycle for operational transfers.
- Controlled warehouse transfers: \`/api/v1/inventory/warehouse-transfers\` supports draft creation, submission, manager approval/rejection, dispatch, partial receipt, final receipt and discrepancy reasons. Dispatch posts source ledger movements; receipt posts only newly received destination quantities. Each state change is organization-scoped, audited, and guarded against active cycle counts. Cross-legal-entity transfers remain blocked pending intercompany accounting.
- Stock reservations: ` /api/v1/inventory/stock-reservations ` supports ATP-checked reservation creation, listing, release, and partial/final fulfillment. Reservation records do not alter on-hand ledger quantities; fulfillment posts SALE movements transactionally. The legacy transfer and controlled warehouse dispatch paths subtract active unexpired reservations before dispatching stock. See ADR-011. This remains an inventory primitive, not a complete sales-order, picking/packing, payment, or delivery system.
- Stock balances: \`GET /api/v1/inventory/balances\` derives on-hand quantities from the movement ledger, with optional location/product filters. This is a quantity view, not financial valuation.
- Inventory write operations require valid OIDC authentication, active organization membership and OWNER/ADMIN/MANAGER/STAFF role; VIEWER is read-only.
- Unit tests cover core product, receipt, transfer and authorization cases. Local PostgreSQL, CI, environment template, ADRs and Sakash reference mapping are present.

## Not yet implemented

- Secure login/user provisioning and granular branch/warehouse permissions.
- Product update/archive, variants, barcodes, price lists and richer textile attributes.
- Cycle-count cancellation/recount controls, returns and optimized persisted balance projections.
- First-class sales orders, pick/pack, customer/supplier management, procurement, POS, wholesale order lifecycle, accounting, taxes, payments and full manufacturing execution.
- Scheduled reservation expiry/release worker and order-cancellation integration.
- Ensure every non-reservation outbound stock flow (including compatibility transfers and controlled warehouse dispatch) protects active reservations before enabling reservation-backed live order traffic.
- Scheduled reservation expiry/release worker and order-cancellation integration.
- First-class sales orders, pick/pack, customer/supplier management, procurement, POS, wholesale order lifecycle, accounting, taxes, payments and full manufacturing execution.
- Offline sync protocol, conflict resolution and device registration.
- Inventory costing/valuation policy and official financial postings.
- Production deployment, monitoring, backup/DR automation, runbooks and legacy import/reconciliation.

## Verification status

The transfer/balance baseline passed CI on commit `e637dca098a5d7294890613e5ac9377eb212abb0`. Stock adjustment approval changes passed CI on commit `2e68118a1264452e617d9528dfffa0b9fc470902`. Cycle-count and controlled warehouse-transfer lifecycle changes are on sequential draft branches and must pass CI schema validation, migrations, typecheck, tests and build before merge/deployment. No production deployment or production-data migration has occurred.
