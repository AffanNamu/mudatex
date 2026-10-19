# Mudatex Enterprise Platform

The new Mudatex platform is being designed for international retail, wholesale, distribution, integrated double-entry accounting, multi-warehouse operations, and full manufacturing. It is a clean project in this repository; Sakash Collection is a separate legacy reference/migration source, not a runtime dependency.

## Status

This repository contains the baseline specification and the implemented backend in [`apps/api`](apps/api/README.md): organization hierarchy, scoped IAM, audit log and product catalogue; the inventory ledger (receipts, issues, reservations, transfers, roll splitting, approved adjustments); online retail POS with pricing, tax snapshots, sessions, payments and returns; procurement (suppliers, approved purchase orders, goods receipts, supplier returns); and the general ledger core (chart of accounts, fiscal periods, approved exchange rates, maker-checker journals, reversals, trial balance); an event outbox with signed webhooks, and manufacturing on the quantity side (versioned BOMs, work orders, material reservation, issue and return, output, quality holds, reconciliation and lot genealogy). Sales, receipts, stock movements and production do not post to the ledger yet, and there is no costing, offline POS, payment providers, receivables/payables or financial statements. A responsive web console ([`apps/web`](apps/web/README.md)) covers sign-in (development only), catalogue, stock, the till, payment confirmation and an access view. Technology choices and operational policies still require ADR approval, and inventory costing is intentionally undecided.

## Start here

- [Enterprise Architecture and Product Specification](docs/ENTERPRISE_ARCHITECTURE_AND_SPECIFICATION.md)
- [PFB → Mudatex Feature Map and Roadmap](docs/PFB_TO_MUDATEX_FEATURE_MAP_AND_ROADMAP.md)
- [Migrating Sakash (PFB) data](docs/migration/SAKASH_MIGRATION.md)
- [Deployment and identity setup](docs/operations/DEPLOYMENT_AND_IDENTITY.md) and [events and webhooks](docs/operations/EVENTS_AND_WEBHOOKS.md)

The specification covers:
- Multi-company and multi-country structure
- Textile catalogue, rolls and units of measure
- Inventory ledger, warehouses and distribution
- Retail POS and broad offline operations
- Wholesale, procurement and customer/supplier accounts
- Integrated double-entry accounting and reconciliation
- Full manufacturing, MRP, BOM, routings, WIP and genealogy
- Security, migration from Sakash, phased delivery and acceptance criteria

## Working principles

1. Protect financial and inventory integrity before adding convenience features.
2. Never use client-only authorization or trust client-reported payment success.
3. Make retried commands idempotent and important state transitions auditable.
4. Offline work must remain visible as queued, accepted, rejected or requiring review.
5. Keep one authoritative writer for each inventory/financial scope during migration.
6. Do not hard-code the inventory costing policy; finance must approve it before valuation and production cost posting.
7. Use synthetic data in development. Production data, secrets and signing materials must not be committed.
8. Use reviewed ADRs for framework, database, hosting, offline sync and other major technical choices.

## Repository maturity

The specification is a plan, not evidence that the application, security controls, tests or infrastructure have already been implemented. Implementation status should be tracked through issues, pull requests and tested release gates.
