# ADR 017 — Automatic drafting of POS revenue journals

- **Status:** Proposed (implemented in `apps/api`). **Disabled for every legal entity until finance enables and configures it.** The accounts, timing and tax treatment below are a starting point for a qualified accountant to confirm; they are not an accounting policy.
- **Date:** 2026-10-19

## Decisions
1. **Drafts only.** A completed sale produces a *draft* journal. Posting still needs someone other than the drafter (the cashier is recorded as the creator), so maker-checker is preserved and nothing reaches the ledger without review.
2. **Event-driven.** A consumer on the event outbox (ADR 016) handles `pos.sale`, `pos.payment_verify` and `pos.return`. A sale posts when it is *completed*: immediately for cash, or when its last non-cash payment is verified. Pending, failed and cancelled sales produce nothing.
3. **Entries.** Sale: debit a clearing account per payment method for the amount confirmed; credit sales revenue for the total less tax; credit sales tax payable for the tax. Return: the mirror image, with the tax portion taken from the original sale's lines and the credit going to the clearing account of the refund method. Lines carry the selling location as a reporting dimension.
4. **Mapping is configuration.** One rule set per legal entity maps roles (cash, card, bank transfer, mobile money, sales revenue, sales tax payable) to that entity's accounts. It must have a revenue account and at least one payment account to be enabled. Turning it off keeps the mapping.
5. **Idempotent by construction.** A unique index on (legal entity, source type, source id) means a replayed event cannot create a second journal.
6. **Problems are visible, not retried forever.** A missing mapping, an archived account or a currency restriction produces a `skipped` row in `posting_log` with the reason, and the event is considered handled. After fixing the configuration, the entry can be retried. Disabled rules, not-yet-completed sales and already-drafted sales leave no trace, so unused features create no noise.
7. **Backfill.** Sales and returns made before enabling are drafted only on explicit request for a date range, safely repeatable.
8. **Posting date** is the sale's local date at its location, in the location's time zone.

## Deliberately not produced
- Inventory, cost of goods sold, margin and any cost-based entries: they need the costing method (ADR 005).
- Revenue deferral, deposits, gift cards or promotions; per-product or per-tax-code revenue accounts; rounding or cash-over/short accounts.
- Settlement entries when card or mobile-money funds reach the bank, and reconciliation of clearing accounts. Clearing accounts will keep a balance until a bank module exists.
- Cash drawer variance at session close.
- Posting for procurement, inventory adjustments, manufacturing or accruals.

## Open questions for finance
- Is revenue recognised at the sale (as here), or later (for example at delivery for orders)?
- One clearing account per method, or per register or location?
- Is tax recognised on the sale, or on payment?
- Should returns of previous periods be dated at the return or at the original sale?
