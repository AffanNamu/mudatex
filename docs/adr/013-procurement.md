# ADR 013 — Procurement: purchase orders, receiving and supplier returns

- **Status:** Proposed (implemented in `apps/api`; needs procurement and finance review)
- **Date:** 2026-10-19

## Decisions
1. **Suppliers are organization-wide master data.** Changing them needs a group-level grant; reading needs any `procurement.read`. Blocked suppliers cannot receive new orders or have drafts submitted. Bank details are intentionally not stored (see limitations).
2. **Purchase orders belong to a legal entity and a destination location.** Every procurement permission is checked at the destination location, so a warehouse's buyers and receivers are scoped like its stock.
3. **Maker-checker approval.** draft -> pending_approval -> approved. The creator cannot approve or reject (also enforced by a database CHECK). Submitted orders are frozen; rejection returns them to draft with a note.
4. **Prices are commercial, not valuation.** Unit prices are per base unit in the order's currency and totals are exact minor units. Receiving posts quantities only. Inventory valuation and landed cost wait for ADR 005.
5. **Receiving is a locked, idempotent command.** The order row is locked, so concurrent deliveries cannot over-receive; the cap is the ordered quantity plus the order's tolerance. Accepted goods enter the ledger through the same lot/roll rules as plain receipts. Rejected goods are recorded with a reason, are not stocked and do not count as received.
6. **Document numbers** (`PO-`, `GRN-`, `RTS-`) are allocated per legal entity inside the document's own transaction, so committed numbers are gap-free and a failed command gives its number back. Lists are ordered by document number, not by timestamp, because concurrent transactions start in a different order than they commit.
7. **Supplier returns** reduce stock through an `supplier_return` movement, cannot exceed what was received and not yet returned, need a specific lot/roll for tracked goods, and fail if the stock is no longer on hand.
8. **On-order quantity** (`GET /procurement/on-order`) sums outstanding quantity on approved and partly received orders only.

## Not built / limitations
- No requisitions, RFQs, supplier price lists or blanket orders.
- No quality inspection or quarantine state: goods are accepted into stock or rejected at the door (the quality module is not built).
- No supplier invoices, three-way match, payments or payables; no purchase tax; no landed cost; no foreign-exchange handling beyond recording the order currency. These need accounting (ADR 005, 006).
- Supplier bank-detail management is deliberately absent. It needs its own maker-checker and online-only rule before payables exist.
- Orders are not sent to suppliers (no e-mail/EDI), there are no amendments after approval (cancel and re-issue), and no cross-company or intercompany purchasing.
- Approval has no value thresholds or multi-step chains yet.
