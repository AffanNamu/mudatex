# Mudatex Enterprise Platform

The new Mudatex platform is being designed for international retail, wholesale, distribution, integrated double-entry accounting, multi-warehouse operations, and full manufacturing. It is a clean project in this repository; Sakash Collection is a separate legacy reference/migration source, not a runtime dependency.

## Status

This repository contains the baseline specification and the first implementation slice: the Phase 1 backend foundation in [`apps/api`](apps/api/README.md) (organization hierarchy, scoped IAM, audit log, product catalogue with units) the inventory ledger (receipts, issues, reservations, transfers, roll splitting, approved adjustments), and online retail POS with pricing, tax snapshots, sessions, payments and returns. Offline POS, payment providers, procurement, accounting, manufacturing and the client apps are not built yet. Technology choices and operational policies still require ADR approval, and inventory costing is intentionally undecided.

## Start here

- [Enterprise Architecture and Product Specification](docs/ENTERPRISE_ARCHITECTURE_AND_SPECIFICATION.md)
- [PFB → Mudatex Feature Map and Roadmap](docs/PFB_TO_MUDATEX_FEATURE_MAP_AND_ROADMAP.md)

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
