# ADR 019 — Web console

**Status:** Proposed (implemented for sign-in, catalogue, stock, point of sale, returns, payment and refund confirmation, purchasing, and access view)
**Decision owner:** Product / engineering lead
**Supersedes:** nothing. Narrows the client-app question left open in the specification.

## Context

The API enforces every permission. Staff need a way to use it that works on a shop-floor tablet, a phone and a desktop without installing anything, so the first client is a responsive web app. A native/offline client remains possible later (ADR 002 is still open).

## Decision

`apps/web`: React 19 + TypeScript + Vite, react-router, no state-management or UI framework. Plain `fetch` wrapper, plain CSS with light/dark themes.

1. **The browser never computes money.** The till shows the totals returned by `POST /v1/pos/registers/:id/quote` and submits `expectedTotalMinor`; a changed price fails the sale instead of charging a different amount. Amounts typed by people are parsed to integer minor units without floating point, and anything over-precise is rejected rather than rounded.
2. **Idempotency keys follow intent.** A key is created once per intent (a sale, a receipt, a session open or close) and kept across retries, so a dropped connection followed by a retry replays rather than double-posts. A key is replaced when the thing being submitted changes.
3. **Permissions in the UI are a courtesy.** Menus and pages are hidden using `/v1/me/grants`, but the server decides every request; the end-to-end tests also check what a person gets when they open a forbidden address.
4. **Sign-in is the identity provider's, over its public REST API.** With `SUPABASE_URL` and the publishable key set at container start, the console shows email + password sign-in against Supabase Auth, refreshes the access token before it expires, signs out at the provider, supports password-reset and invitation links, and keeps tokens in `sessionStorage` (closing the tab signs out). No SDK, no cookies. With neither set it falls back to the development sign-in (`/v1/dev/token`, absent in production). Mudatex stores no passwords. Adding Firebase or another provider means replacing `lib/identity.ts`; nothing else depends on how the token was obtained.
5. **Accessible by test.** Browser tests run axe (WCAG 2 A/AA) on the main screens in each state, and check there is no sideways scrolling at phone width.

## Consequences

- Online only: the till stops working without a connection. Offline selling needs its own design (ADR 002).
- Server changes this work needed, all additive: location names visible to anyone who works there; product name / SKU / lot code on stock balances and sale lines; a `receipt` filter on the sales list; a list of returns (to find refunds awaiting payout); and supplier, destination and product labels on purchase orders.
- Confirming a non-cash payment is a separate screen for a different person than the cashier (the API already forbids confirming your own).

## Evidence

- `npm test` in `apps/web` (money parsing, API client behaviour, discount parsing).
- `npm run e2e` in `apps/web`: 30 browser tests, including sign-in against a stand-in for Supabase Auth (wrong password, unconfirmed email, unknown Mudatex user, token refresh and revocation, reset and invitation links), against the built API and a clean database, including a cash sale with change, a stock shortage, a refused discount, a card sale that holds stock until a supervisor confirms, cancelling a pending sale, closing the session with a cash variance, a partial return over the refund limit, a card refund paid out by a second person, a purchase order drafted, approved by someone else and received in parts with a rejection and a roll, axe checks and a phone-width layout check. CI runs them in the `web` job.

## Revisit trigger

Real identity provider chosen; offline design accepted; first production user feedback on the till.
