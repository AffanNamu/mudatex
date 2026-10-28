# Mudatex: what we are building, and where we are

*Written 25 October 2026, the day the first sign-in to the live system succeeded.*

## 1. What Mudatex is

Mudatex is one platform to run a large, international textile business: retail shops, wholesale and distribution,
procurement, manufacturing and the accounting that sits under all of it. It is designed for several companies in several
countries, with hundreds of staff who must each see and do only what their job needs.

It grows out of **Sakash Collection**, the existing single-business app (Flutter, Firebase, Supabase, Paystack). Sakash proves
the workflows (selling fabric, a shop till, orders, delivery, notifications). Mudatex keeps those capabilities but is built on
foundations that suit a large company, and does not copy Sakash's code or its weaknesses (see section 7).

### The rules it is built on
- **The server decides.** The screen never works out a price, a total, a tax or a permission. It asks the server and shows the
  answer. Anyone with browser tools can alter a screen; they cannot alter the server.
- **Inventory is a ledger.** Stock is never "edited". Every receipt, sale, transfer, adjustment and production run is a
  permanent entry, and balances are totals of those entries. A check recomputes balances from the ledger and reports any
  disagreement.
- **Money is whole minor units** (kobo, cents), never fractions, so totals always add up exactly.
- **Two people for anything risky.** Approving a purchase order, posting a journal, approving a bill of materials, confirming a
  card payment, paying out a refund, releasing a quality hold, reopening a closed accounting period, and approving an exchange
  rate each need a person other than the one who started it.
- **Access is scoped.** A role can be granted for the whole group, one country, one company, or one shop. Staff see only
  what their grants reach.
- **Everything leaves a trail.** An append-only audit log records who did what; it cannot be edited or deleted, even by
  administrators.
- **Safe to retry.** A request repeated after a dropped connection does not double-charge or double-count.

## 2. How it is put together

```
 Staff browser  ->  Web console (static site, Vercel)
                          |  calls
                          v
                    API (one serverless function, Vercel)  ->  Database (PostgreSQL, Supabase)
                          ^                                         
 Staff sign in  ->  Supabase Auth (email + password; the API checks its signed tokens)
```

- **Web console:** React, runs on any modern browser including a phone. Sign-in, menus and every screen listed below.
- **API:** the rules engine. Fastify (TypeScript). One deployment serves every screen and, later, apps and partners.
- **Database:** PostgreSQL on Supabase. Tables are locked so Supabase's own public interface cannot read them.
- **Sign-in:** Supabase Auth. Mudatex stores no passwords.
- **Quality net:** automated tests (325 on the server, about 80 that drive real browsers across the console and the shop, including
  accessibility and phone-width checks) run on every change in GitHub, along with a secret scan, a dependency security audit and container builds.

## 3. What is built

| Area | What works today |
|---|---|
| **Organization and access** | Groups, companies, countries, locations; roles and permissions; scoped grants; no one can grant what they do not hold; audit log. |
| **Catalogue** | Products and variants, units of measure with conversions (roll, metre, yard), lot and roll tracking, barcodes, effective-dated price lists, tax codes (inclusive or exclusive). |
| **Inventory** | The ledger; receipts, issues, transfers (with in-transit), reservations, roll splitting, counts and approved adjustments; lots held for quality. |
| **Point of sale** | Registers and sessions with opening float; barcode or search; server-priced carts; discounts capped by register and permission; cash with change; card, transfer and mobile money held until a second person confirms; returns and refunds; closing the drawer with cash variance. Receipts print from the browser. |
| **Procurement** | Suppliers; purchase orders drafted, submitted and approved by different people; partial goods receipts with rejections and roll codes; supplier returns; on-order visibility. |
| **Accounting** | Chart of accounts, fiscal periods, balanced journals (drafted and posted by different people), reversals, trial balance, account ledgers, approved exchange rates, period close and two-person reopen. Optional drafting of POS revenue journals (off by default). |
| **Manufacturing** | Versioned bills of materials with approval, work centres and routings, work orders with material reservation, issue and return, step-by-step operations, finished-goods output with by-products, quality holds, tolerance-checked closing with a recorded variance reason, lot genealogy. |
| **Integrations** | A durable event outbox and signed webhooks with retry and dead-letter handling. |
| **Sakash migration tooling** | Profile, plan, import and reconcile commands; personal data removed by a deny-by-default allow-list; opening stock posted as ledger receipts; safe to re-run. |
| **Business setup (console)** | Screens to create companies, shops and warehouses, units, tax codes, price lists and prices, and till registers. |
| **Online store** | A storefront per company (price list, stock locations, departments, publishing, delivery zones, coupons, contact and bank details); a public catalogue API where prices, tax, stock and delivery are all worked out by the server with the same engine as the till. |
| **Customer shop** | A fast, accessible website (`apps/shop`): home, departments, search, filters, product pages sold by the metre or roll, basket priced by the server, accounts, addresses, wishlist, checkout, order tracking, reviews, coupons. Pay by bank transfer or by card through Paystack (server-verified). |
| **Orders** | Server-priced orders reserve stock, expire if unpaid, and move through paid, preparing, shipped (stock leaves the shelf) and delivered; cancellation, late-payment protection and refund-owed tracking; an order desk in the console; email to the customer at each step. |
| **Wholesale** | Trade accounts: apply online, staff approve with a trade price list, credit limit and terms; orders on account with credit checked in the order's own transaction; part payments; a statement. |
| **Refunds** | Two-person refunds on online orders: asked by one, approved by another; card refunds go back through Paystack, bank refunds are recorded when paid out. |
| **Collections** | Overdue trade balances: reminders before and after the due date (once each, in the customer's language), automatic hold when a business is too late and automatic release when it pays, an ageing view for staff and a manual reminder. Guide: `operations/COLLECTIONS.md`. |
| **Quotes** | Staff price a list of goods for a trade buyer at agreed prices for a limited time (below-list prices need their own permission); the buyer is emailed, opens it in the shop and accepts it into an order at exactly those prices, on account or by transfer. Guide: `operations/QUOTES.md`. |
| **Standing orders** | A trade buyer repeats an order weekly, fortnightly or monthly: the system places an ordinary order each time it is due at that day's trade prices (stock and credit rules apply), tells the buyer when one fails, pauses itself after three failures, and never places missed days in a burst. Guide: `operations/STANDING_ORDERS.md`. |
| **Invoices and receipts** | Every online order has a printable invoice, receipt or cancelled-order page for the customer (in their language) and for staff: seller and buyer details, lines with tax, tax summary by rate, payments and refunds, balance owed with bank details. Read from the recorded order, never recalculated. Not yet a statutory tax invoice (needs finance decisions). Guide: `operations/DOCUMENTS.md`. |
| **Two-step sign-in** | Staff can add an authenticator app (Security page); a code is then asked after the password. With `STAFF_MFA=required` the API refuses any staff request from a sign-in without a code and sends people without an app to set one up. Shop customers are unaffected. Guide: `operations/TWO_STEP_SIGN_IN.md`. |
| **Backups** | A nightly workflow takes an encrypted dump of the database, restores it into an empty scratch database and checks it (schema, books balance, stock, payments); failure emails the owner; the same backup-and-restore runs in CI on every change. Needs two GitHub secrets. Guide with the recovery steps: `operations/BACKUPS.md`. Supabase Pro backups are still recommended. |
| **Delivery companies and tracking** | The business adds the delivery companies it uses (staff-entered, webhook, or code connector). Sending an order records the parcel; updates arrive by signed webhook, hourly polling or staff entry; the customer follows the parcel on their order page in three languages; delivery closes the order, a failed delivery warns staff. Guide: `operations/DELIVERY.md`. |
| **Order routing** | Each online order is sent from the nearest location that has all of it, by the states each location serves, else split across locations; staff see where it ships from. Guide: `operations/ORDER_ROUTING.md`. |
| **Online returns** | Customers ask to return items from a delivered order within the store's return window (default 48 hours); staff approve or decline (customer is emailed in their language); approval raises a refund for the goods' value for a second person to approve; returned goods are booked in and put back on the shelf. Guide: `operations/ONLINE_RETURNS.md`. |
| **Text messages** | Shoppers who opt in are texted when an order is paid, sent or delivered (in their language, with a link). Off until a Termii key and sender ID are set; written from the provider's public description and not yet tried with a live account. Guide: `operations/SMS.md`. |
| **Offline till** | Cash sales continue with no connection: a saved price list, local pricing identical to the server's, a safe on-device queue, automatic catch-up with official receipt numbers, server re-pricing with variance, shortfalls listed for the stock controller. Guide: `operations/OFFLINE_TILL.md`. |
| **Stock on a phone** | Count a shelf, receive against purchase orders or without one, and look up stock from a phone: barcode scanning (scanner, typed, or camera), blind counts compared against the books as they were at counting time, differences raised as one maker-checker adjustment, a downloaded stock list and an on-device queue so work continues without signal. Guide: `operations/STOCK_APP.md`. |
| **Shop languages** | English, French and Hausa with a picker and browser-language detection; prices unchanged across languages. Hausa is a draft that needs a native reader. Guide: `operations/SHOP_LANGUAGES.md`. |
| **Dashboards** | The console home shows sales by day, by channel (till, online) and by currency, best sellers, products running low and what needs attention (orders to pay or ship, enquiries, reviews, wholesale applications, offline shortfalls), limited to what each person may see. |
| **Company website** | Our story, what we do, brands, find us, careers, made-to-order, wholesale and contact pages; enquiries land in a staff inbox. |
| **Hosting** | Web, API and database deployed and answering; setup guide in `docs/operations/GO_LIVE.md`. |

## 4. Where we are right now

**Live, for the first time.** On 25 October 2026 the console at its Vercel address accepted the owner's sign-in, the API
reported ready with every database migration applied, and the welcome page showed the administrator's 50 permissions.

It is a **test environment on free plans**: Vercel Hobby and Supabase Free. It holds no real business data and should not
until the plans are upgraded (free Vercel is for non-commercial use; free Supabase pauses when idle and has no dependable
backups).

**Not yet proven:**
- No real data has ever been in it, and no shop has used the till.
- The Sakash migration has only run on made-up data.
- The Vercel and Supabase deployment has just come up; load, cold-start time and connection limits are untested.

## 5. What is not built yet

1. ~~Standing orders and quotes for wholesale buyers~~ — built (trade accounts, trade prices, credit, statements, quotes and standing orders).
2. ~~Dunning for overdue trade balances~~ — built (see Collections).
3. **Wider offline work.** The till can now sell cash offline (see ADR 002); offline card payments, rolls and lots, stock
   receiving and counts are not offline-capable.
4. **Store-listed phone apps** (Play Store / App Store) and **WhatsApp notifications** (email, phone push and SMS are done). The shop and console are already installable on phones from the browser.
5. ~~Delivery~~ — built as a connection point for outside delivery companies (no riders; Mudatex does not deliver). The first real company connector waits for a delivery company's account and API details. ~~Order routing to the nearest shop~~ — built (by the states each location serves; see Order routing). (Dashboards: a first version exists; profit and valuation need costing.)
6. **Costing and valuation,** and automatic posting of stock and online sales to the ledger. Blocked on finance decisions.
7. ~~Second-factor sign-in for staff~~ — built (authenticator app, optional per person or compulsory with `STAFF_MFA=required`). ~~Customer-facing documents~~ — built (invoices and receipts; statutory tax invoices per country still need finance decisions). ~~Backups plan~~ — built (nightly encrypted dump, restored and checked every night; see Backups).
8. **Content the company must supply:** product photos, brand descriptions, shop addresses and hours, delivery and return
   terms, and review of the facts on the company pages.
9. **Languages** (Hausa, French) and a blog or lookbooks.

## 6. Decisions and inputs that gate progress

| Needed from | What | Unblocks |
|---|---|---|
| Finance | Inventory costing method; chart of accounts; tax treatment; which sales post to the ledger and when (ADRs 005 to 007) | Valuation, financial statements, automatic posting |
| Owner | Pilot country and first site | Realistic setup data and tax rules |
| Owner | Whether Mudatex runs alongside Sakash, and for how long | Cutover plan |
| Owner | Must shops sell when the internet is down? | Offline design (largest remaining piece) |
| Owner | Read-only Sakash export | A real migration rehearsal |
| Owner | Upgrade Vercel and Supabase to paid plans before real data | Safe production use |

## 7. Sakash: what we learned, and what to fix there

Reading Sakash's rules and code found serious payment weaknesses (full detail in `docs/migration/SAKASH_PAYMENT_SECURITY.md`
and `docs/migration/sakash-hardening/`). The worst: the app marks an order paid when the customer taps a button, without asking
Paystack, and the amount charged is whatever the app sends. A tested replacement (server-priced orders, signed Paystack
webhook) is written but not applied. Signing keys for the Play Store upload were committed to a public repository and should
be reset. Mudatex's own till avoids all of this by design.

## 8. Recommended order of work

1. **Pilot run** with fake data on the free plans: set up a company, publish products, place and fulfil orders (guides:
   `operations/GO_LIVE.md` and `operations/GO_LIVE_SHOP.md`). Fix what real use shows.
2. **Content and photos** from the company; connect Paystack (test keys) and an email sender.
3. **Trial the offline till** in one real shop.
4. **Sakash migration rehearsal** on a real export, then plan cutover shop by shop.
5. **Upgrade to paid plans** before any real data enters.
6. WhatsApp and push notifications, delivery, dashboards, mobile apps, then costing and statements once finance has decided.

## 9. Running costs (check current prices)

Free while testing. For real use: Vercel Pro about $20 per user per month, Supabase Pro about $25 per month. Paystack's own
transaction fees apply once online payments exist.

## 10. Where to read more

`README.md`; `docs/ENTERPRISE_ARCHITECTURE_AND_SPECIFICATION.md` (the full requirements); `docs/adr/` (20 recorded design
decisions); `docs/operations/GO_LIVE.md`; `docs/migration/`.
