# ADR 004 — Inventory ledger, reservations and movement states

- **Status:** Proposed (implemented in `apps/api`; needs inventory-controller sign-off and a load test before pilot)
- **Date:** 2026-10-19

## Decision
1. **Immutable movement ledger.** `stock_movements` is append-only (database triggers refuse update, delete and truncate). Quantities are signed, in the product base unit, with `numeric(20,6)` precision. Corrections are new movements.
2. **Transactional projection.** `stock_balances` is updated in the same transaction as the movements it reflects. `GET /v1/inventory/reconciliation` rebuilds balances from the ledger and reports any difference.
3. **No negative stock, no over-reservation.** Enforced by CHECK constraints on the balance row (`quantity >= 0`, `reserved <= quantity`), so concurrent commands are serialized by row locks and the database rejects any that would oversell. Application pre-checks are not relied on. Rows are locked in a fixed order to avoid deadlocks.
4. **States.** `on_hand` and `in_transit`. A transfer dispatch moves stock from source `on_hand` to destination `in_transit`; receipt moves it to destination `on_hand`; cancellation returns the remainder to source. Reservations are a counter on the balance (not ledger movements) with their own documents, expiry and partial fulfilment.
5. **Rolls and lots.** Variants are `none`, `lot` or `roll` tracked and the mode is frozen once stock history exists. Roll splits conserve quantity, create child rolls with `parent_lot_id` lineage, and cannot consume reserved stock.
6. **Units.** Callers may enter a quantity in another unit only through an explicit product conversion; the result must be exactly representable in the base unit's precision, otherwise it is rejected, never rounded. Arithmetic uses BigInt fixed-point, not floating point.
7. **Idempotency.** Every state-changing inventory command requires an `Idempotency-Key`. The key row is written in the command's transaction; concurrent duplicates wait and replay the stored response; reuse with a different body is rejected; failed commands are not stored.
8. **Adjustments are maker-checker.** A request changes nothing; a different user with `inventory.adjust.approve` over the location posts it. The database also forbids requester = approver.
9. **No valuation.** There are no cost columns. ADR 005 (costing method) is still open and nothing here assumes one.

## Known limits and follow-ups
- Intercompany transfers are rejected until accounting exists.
- Tracked variants are reserved against a specific lot/roll; variant-level reservation that picks rolls at cut time is not built.
- Transfer shortages stay in transit until cancelled; there is no loss write-off workflow yet.
- Cycle counts, a reservation-expiry worker/scheduler, idempotency-key retention cleanup, and an outbox for downstream events are not built.
- Reads filter by location scope in SQL; very large histories need pagination cursors and partitioning review.
- Concurrency tests run 30 parallel requests against one database; they are not a production load test.
