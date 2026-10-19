# ADR 018 — Migration from Sakash (PFB)

- **Status:** Proposed (tooling implemented and tested on synthetic data; not yet run on real data). Refines ADR 010.
- **Date:** 2026-10-19

## Decisions
1. **Catalogue and opening stock are migrated as live data; history is archived.** Products, prices and an opening stock count become real Mudatex records. Orders, POS sales, receipts and payments become a read-only archive. Replaying history as live sales would distort stock and the books and invent journals.
2. **Personal data does not cross.** An allow-list, applied at export time and again at import, keeps only business fields. Customer and staff collections are not read. Dropped-field counts are shown in the profile so the filtering can be audited.
3. **No dual authoritative writer** (ADR 010). Opening stock is posted once per product, at its first import, as ordinary ledger receipts. Re-imports never touch stock.
4. **Every record is accounted for.** Each source record is created, updated, unchanged or in the exception register with a code and message, and source counts equal the sum of those. Reconciliation compares counts, stock and totals exactly.
5. **Traceability.** `legacy_mappings` links each source id to its Mudatex record with a checksum, so re-runs detect change and any record can be traced back.
6. **Repeatable and reversible before cutover.** `plan` runs everything and rolls back. `import` is idempotent, and concurrent runs cannot duplicate records.
7. **Pieces, not yards.** PFB counts stock in whole items and prices per item, so the default base unit is a discrete piece, overridable before first import.

## Not built / open
- Not tested on real Sakash data or against a live Firestore. The export script is untested beyond syntax.
- No customer, staff or loyalty migration; no per-variant stock; promotions are attributes.
- No automated cutover tooling, final-delta handling or Firestore write-freeze; those are manual steps in the runbook.
- Orders are archived with their original totals but are not reconciled to payments or to any ledger.
