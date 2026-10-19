# ADR 015 — Manufacturing (quantity side) and quality holds

- **Status:** Proposed (implemented in `apps/api`). Needs production-process workshops (ADR 007) and quality-team review. Costing, WIP valuation, labor and machine rates, overhead and variance accounting are **not built** and stay gated on ADR 005/007.
- **Date:** 2026-10-19

## Decisions
1. **A BOM version carries its routing and is frozen once active.** Components (quoted per a nominal output quantity, with line scrap), by-products, operations (work centre, setup and run minutes, QC checkpoint) and expected yield live on one version. Approval needs a second person, activating a version retires the previous active one, and database triggers refuse any change to a non-draft version. A product may not end up inside its own bill of materials at any depth.
2. **A work order freezes what it needs.** Creating one snapshots the required component quantities and the routing from the active BOM, so later BOM versions never alter it. Required material = line quantity x planned output x (1 + scrap) / (nominal output x expected yield), rounded **up**.
3. **Release reserves, or reports shortages.** Release plans allocation from free stock (on hand minus other documents' reservations): oldest lot or roll first for tracked material, never lots on quality hold. If anything is short, nothing is reserved and the shortages are returned. Reservations use the same ledger machinery as sales, so concurrent releases cannot over-reserve.
4. **Issue is capped at what was reserved.** Beyond that needs both a reason and a separate `manufacturing.issue.exception` permission, is drawn from free stock only, and is flagged on the record. Unused material goes back by a return, capped by what was issued from that lot.
5. **Operations run in sequence**, recording completed and scrap quantity and minutes. Output (and declared by-products) goes into stock within an over-production allowance. By-products must be declared on the BOM.
6. **Quality holds** are a state on a lot or roll. A quarantined lot cannot be issued, sold, transferred, reserved or fulfilled from an earlier reservation; it can still be returned, adjusted or sent back to a supplier so it can be disposed of. Whoever places a hold cannot release it. A BOM that requires QC puts each output into a new, quarantined lot until someone else releases it, so such BOMs must produce a lot- or roll-tracked product.
7. **Closing reconciles quantities.** Net consumption per component is compared with what the *actual* output should have consumed, within the order's tolerance, and the report also shows yield, scrap, by-products and minutes. Closing outside tolerance needs a recorded variance reason. Completing releases anything reserved but never issued.
8. **Traceability both ways.** From a finished lot back to the work orders, operations and material lots consumed, and from a material lot forward to the work orders, output lots and retail sales it reached. Roll lineage (splits) is followed in both directions and multi-level production is followed up to 10 levels. Work-order-level genealogy: every lot consumed by an order is treated as a possible input to every output of that order.
9. **Idempotent commands.** Issue, return, output, completion and the rest take an `Idempotency-Key`, so a repeated message cannot duplicate stock movements.
10. **Stable ordering.** Child rows written in one transaction are read back in insertion order (`seq`), after a defect where `ORDER BY created_at, id` returned them in arbitrary order.

## Not built / limitations
- **No costing at all:** no standard or actual cost, WIP valuation, labor/machine/overhead rates, scrap or rework accounting, or production P&L. The reconciliation report says so explicitly.
- Planning is single-level: the requirements endpoint compares one BOM's needs with stock and open purchase orders at a location. There is no multi-level MRP, forecasting, lead-time scheduling or planned-order generation.
- No work-centre calendars, shifts, capacity, downtime or maintenance; no labor or machine tracking beyond minutes per operation.
- No inspection plans, sampling, nonconformance or rework routing. A hold is a single reason on a lot; disposition is by adjustment or supplier return.
- Quality holds apply to lot- and roll-tracked stock only; untracked stock cannot be quarantined.
- BOM routing is tied to work centres at one location, so a BOM can only be run where its work centres are.
- No substitutions, co-products with their own routing, subcontracting, or partial-quantity operation tracking per batch.
- Genealogy is order-level, not per-unit. It will over-report which lots fed a given output when one order consumed several lots.
- Traceability needs an organization-wide read grant.
