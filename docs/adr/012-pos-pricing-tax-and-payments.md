# ADR 012 — POS pricing, tax snapshots, money rounding and payment verification

- **Status:** Proposed (implemented in `apps/api`; needs finance and local tax-adviser review before any live trading)
- **Date:** 2026-10-19

## Decisions
1. **Money is integer minor units** (`bigint`), with the currency's minor-unit count from a `currencies` table. Unit prices are exact decimals (up to 4 places) per product base unit. No floating point.
2. **Rounding rule (to be approved):** every line is rounded half-up to minor units at each step (gross, then percent discount, then tax). A sale total is the sum of rounded lines, so a receipt always adds up. Finance must confirm this per jurisdiction; a different rule is a change in `domain/money.ts` only.
3. **Tax is configuration, not law.** Tax codes (rate, price-inclusive or exclusive) belong to a legal entity, are immutable, and a rate change is a new code. Each price-list item points at a code. Tax is computed after discount. These records must be approved by local accountants; nothing here asserts any country's rules.
4. **Effective-dated prices.** A database exclusion constraint prevents overlapping price periods for one variant on one list. Setting a new price closes the open one at that instant.
5. **Snapshots.** A sale line stores the unit price, tax code, rate and inclusive flag it was sold at, so later price or tax changes never alter a receipt. The server prices every sale; clients may send `expectedTotalMinor` and get 409 if the total differs.
6. **Receipts and returns are numbered per register** (`CODE-000001`, `R-CODE-000001`) from a counter locked in the sale's transaction, so numbers are gap-free and a failed sale does not consume one. Unique per legal entity.
7. **Cash sales complete immediately.** Card, bank-transfer and mobile-money payments are recorded as `pending` with a provider reference, the sale is `pending_payment`, and its stock is **reserved, not issued**. Another person must verify the payment (a stand-in for a provider webhook/adapter, which does not exist yet), which then issues the stock. A failed or cancelled sale releases stock and voids any cash already taken (the cash goes back to the customer).
8. **Discounts:** a register has a maximum discount; above it needs `pos.discount.override`. Discounting at all needs `pos.discount`.
9. **Returns** reference the original sale line, cannot exceed what was sold, must refund by a method the customer paid with, and can restock or not. Refund shares use cumulative rounding so all partial returns of a line sum exactly to the line total. Refunds above the register threshold need `pos.refund.approve`. Non-cash refunds stay `pending_disbursement` until a second person records the payout.
10. **Sessions:** one open session per register; only its cashier sells on it. Closing computes expected cash (float + cash sales - cash refunds), records the counted amount and variance, and is blocked while payments are pending.

## Not built / limitations
- No payment-provider adapters, webhooks or reconciliation to settlements. "Verify" is a manual stand-in.
- **Offline POS is not implemented.** Commands are idempotent and carry `deviceId` and `clientTimestamp`, which are the hooks an offline queue needs, but there is no local store, sync protocol, offline stock allowance, price-snapshot expiry or conflict queue (ADR 002 is open).
- No customers, loyalty, promotions engine, hold/resume carts, gift cards, split-tender change rules beyond cash, or fiscal-printer/e-invoice integration.
- Pending-payment sales hold stock until verified or cancelled; there is no timeout.
- No ledger postings: sales do not create journals until the accounting module and costing policy (ADR 005) exist.
- Receipt rendering (PDF/print) is a client concern; the API returns the full receipt data.
