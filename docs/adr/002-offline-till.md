# ADR 002 — Offline till: what a till may do without the internet, and how it catches up

- **Status:** Proposed (server and till implemented; to be proven in a real shop before it is relied on)
- **Date:** 2026-10-26
- **Decision owner:** Owner and shop operations (this is a business-risk decision as much as a technical one)

## Context
Many of the group's shops and malls have unreliable internet. A shop that cannot sell when the line drops loses money, so the till must keep selling. But the server is the only place that owns prices, tax, stock and money. An offline till must therefore be allowed to do *less* than an online one, and everything it does must be checked again when it reconnects.

## Decision
1. **What works offline: cash sales of ordinary (untracked) products only.** Cash is the only payment the cashier can fully verify without a provider. Card, bank transfer and mobile money need the provider, so they stay online-only. Rolls and lots (tracked stock) need a lot choice and quality-hold checks, so they stay online-only.
2. **What never works offline:** returns and refunds, voiding a sale, discounts above the register's limit, opening or closing a session, and anything that needs another person's approval.
3. **A session is opened online first.** The till then downloads an *offline pack*: the register's current prices, tax codes, barcodes, units, the stock list as it stood, and the discount rules the cashier may use. The pack is only used for the cashier and session it was made for, and it expires after 24 hours.
4. **Sales are kept on the device,** in the browser's own database, one record each, with a unique id made on the device. Each gets a provisional receipt number (`OFF-<till>-<n>`) printed on the paper receipt.
5. **Catching up is idempotent.** The till sends its sales in order. The server treats the unique id as an idempotency key: sending a sale twice creates it once.
6. **The server re-prices every offline sale at the moment it was sold,** using the same pricing engine and effective-dated prices as online sales. If the total differs from what the till showed, the sale is still recorded at the server's total, the difference is stored as the sale's *variance*, and the cash drawer's variance at closing will show it. The server never accepts a price from the till.
7. **Stock: the goods have already left the shop.** The server issues what the books can cover. Any shortfall is not hidden and is not allowed to make stock negative: it is recorded as an *offline stock exception* for the stock controller to explain (a late receipt, a counting error) and clear. The sale itself stands.
8. **Time:** the sale time is the till's clock, clamped to between the session's opening and the moment of upload, so a wrong clock cannot post a sale into the past or the future.
9. **Receipt numbers:** the official, gap-free receipt number is issued by the server when the sale is received. Reports use the official number; the provisional number is kept beside it so a paper receipt can be matched.
10. **Before closing the till** the session must be caught up. The till refuses to close while sales are waiting, and the server only accepts sales into a session that is still open.

## Consequences
- A shop can keep trading cash through an outage with at most 24 hours of risk on prices and stock lists going stale.
- Cashiers see a plain "working offline" banner and the number of sales waiting. Nothing is lost if the browser is closed: the sales stay on the device until they are sent.
- Risks accepted: a stolen or cleared device loses unsent sales (mitigated by catching up as soon as the line returns); stock may be oversold against a stale list (surfaced as exceptions, not hidden); price changes made during an outage apply at sale time on the server, so a customer can have been quoted an older price (surfaced as variance).

## Not covered
Offline stock receiving, transfers and counts; offline card payments; multi-till sharing of one offline pack; native apps. Each needs its own decision.

## Evidence and tests
Server tests cover idempotent re-sending, re-pricing at the sale time, variance, shortage exceptions, clock clamping, closed sessions and permission checks. Browser tests cover going offline, selling, and catching up.

## Revisit trigger
First real shop trial; any incident of lost or duplicated sales; a decision to allow card payments or tracked stock offline.
