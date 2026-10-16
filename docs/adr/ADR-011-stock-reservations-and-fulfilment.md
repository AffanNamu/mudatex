# ADR-005: Stock reservations and order fulfilment

- Status: Proposed for review
- Date: 2026-10-16

## Context

Confirmed orders need stock protection before picking/dispatch. A reservation must not be represented as a physical inventory movement: doing so would distort on-hand stock and cycle-count snapshots. Available-to-promise (ATP) is instead calculated as ledger-derived on-hand minus the unfulfilled remainder of active, unexpired reservations.

## Decision

- Store reservations and reservation lines separately from the append-only inventory movement ledger.
- Scope every reservation to an organization, legal entity, stock location and external order reference. The order reference is an integration key, not a replacement for a future first-class sales-order aggregate.
- Reserve only active products belonging to the selected location's legal entity and only when ATP covers every requested line.
- Serialize reservation creation and fulfillment on the stock-location row. Use organization-scoped idempotency keys and audit events.
- Fulfil reserved quantities by posting SALE inventory movements and incrementing fulfilled quantities in the same database transaction.
- Release unused quantities by changing reservation state; never delete a reservation or rewrite inventory movements.
- Expiry is checked at reservation/fulfilment time. A scheduled expiry worker and explicit cancellation integration remain future work.
- Keep payment status, tax, pricing, customer records, picking/packing, carrier dispatch and delivery as separate future modules. Do not imply payment settlement from a reservation.
- Reservations do not yet replace every legacy outbound-stock path. Before enabling reservations for live order traffic, all outbound operations (including the compatibility transfer endpoint and controlled warehouse dispatch) must preserve reserved ATP, and expiry/release policies need operational ownership.

## Consequences

- On-hand remains the sum of the inventory movement ledger; ATP is a separate operational measure.
- The initial implementation supports reservation creation, listing, release and partial/final fulfilment, but is not a complete sales-order/fulfilment system.
- Inventory costing and accounting valuation remain undecided. A fulfilment movement is not itself a financial posting.
- Future work should introduce first-class sales orders, order-line state, pick/pack records, delivery tracking and a background expiry job with observability.

## Acceptance criteria

1. A reservation is rejected if any line's requested quantity exceeds ATP.
2. Concurrent reservations for the same location/product cannot over-reserve stock.
3. A repeated idempotency key with the same payload returns the existing reservation; a different payload conflicts.
4. Reservation creation/release never changes the inventory movement ledger.
5. Fulfilment posts one idempotent SALE movement per requested product and updates fulfilled quantities atomically.
6. Partial fulfilment preserves the remaining reservation; full fulfilment transitions to FULFILLED.
7. Expired/released/fulfilled reservations cannot be fulfilled.
8. Fulfilment is blocked during an active cycle count and fails closed when available physical stock cannot cover active reservations.
9. All operations enforce OIDC identity, active organization membership, write role, organization scope and audit logging.
10. The full CI suite validates schema/migrations, typechecks, tests and builds before merge.
