# PFB → Mudatex Feature Map and Roadmap

**Status:** Proposed baseline for review
**Purpose:** Define how Mudatex reaches feature parity with PFB (Sakash Collection, https://github.com/AffanNamu/PFB) at the scale of a large, multi-company, multi-country business.

## 1. Direction

Decision recorded for this document: **Mudatex keeps PFB's product capabilities but is built on the enterprise backend described in the [architecture specification](ENTERPRISE_ARCHITECTURE_AND_SPECIFICATION.md)** — a PostgreSQL-backed modular monolith behind a versioned API, with authorization enforced server-side.

PFB is a single-business Flutter app on Firebase Auth, Cloud Firestore, FCM, Supabase Edge Functions and Paystack. Those choices fit a small team, but several do not carry over to a company with hundreds of internal users, many locations and real accounting:

| PFB approach | Why it does not scale to Mudatex | Mudatex approach |
|---|---|---|
| Firestore documents with client-side reads/writes, protected by Security Rules | No multi-document transactions across stock, orders and payments at the needed integrity; reporting and ledgers are awkward | PostgreSQL transactions, immutable inventory ledger, double-entry journals |
| Roles as labels (cashier, store manager, admin, super admin) plus hard-coded super-admin UIDs in the client | A single global role cannot express company/country/branch scope | Composable permissions scoped to legal entity, country and location, checked on the server |
| Shared function secret compiled into the Flutter client | Not confidential; anyone can extract and reuse it | Authenticated user tokens verified by the API; no shared client secret |
| Payment "success" confirmed by the client after returning from Paystack | A return is not proof of settlement | Server-side verification and signed webhooks; idempotent fulfilment |
| Notifications sent from app-side service logic | Missed events on client failure; sequential sends | Durable outbox, retrying workers, dead-letter visibility |
| One currency, one country assumption | Mudatex is international | Functional/transaction currencies, effective-dated rates, per-country tax and documents |

Mudatex is a new codebase. PFB is a **reference for workflows and a possible migration source**, not code to copy. Its signing keys, Firebase/Supabase configuration, `google-services.json`, application IDs and secrets must not be brought into this repository.

## 2. Feature map

Each PFB module, what Mudatex needs beyond it, and the spec section that governs it.

| PFB module | What PFB does today | Mudatex enterprise equivalent | Spec § |
|---|---|---|---|
| Auth (`features/auth`, Firebase Auth, Google sign-in) | Email and Google sign-in for customers and staff | Managed identity provider with enterprise sign-in (SSO/MFA for staff), tokens verified server-side; customer accounts separate from staff memberships | 3, 11 |
| Admin roles and `admins` collection | Four role labels; coverage areas, capacity, active flag per admin | Scoped IAM: group → legal entity → country → location; permissions composed per role; audit of changes | 2, 4, 11 |
| Products (`products`, textile attributes) | Fabric type, material, colours, sizes, yardage, GSM, care, origin, ratings | Product/variant catalogue with configurable textile attributes, units of measure (metre, yard, roll, piece), conversions, barcodes, effective-dated price lists | 5 |
| Categories, Cloudinary media | Category list; images via Cloudinary wrapper | Category tree; object storage with signed access for images/documents | 3, 5 |
| Favorites, cart, profile/addresses | Per-user favourites, cart, selected delivery address | Customer/wholesale portal (later phase); quotes and sales orders for B2B | 2, 8 |
| Checkout and Paystack (`payment_service`, `init-paystack-transaction`) | Initialises a Paystack transaction through a Supabase function; client confirms on return | Payment-provider adapters per country; server verification and webhooks; payment records tied to invoices and the ledger | 4, 10 |
| Orders and statuses | String statuses (`pending`, `processing`, `shipped`, `delivered`, `cancelled`); payment reference/status; tracking number | Sales order state machine with validated transitions, reservations against stock, partial fulfilment, invoices and returns | 6, 8 |
| Delivery tracking / `rides` (legacy) | Map and tracking screens; legacy ride model kept for compatibility | Fulfilment module: pick, pack, dispatch, shipment, delivery attempts, proof of delivery; no legacy ride collection | 8 |
| Admin assignment, escalation, reassignment | Scores admins by coverage text, state, radius, workload; falls back to super admin; manual reassignment | Order routing to fulfilling location by stock availability, coverage and capacity; escalation and reassignment as audited workflow actions | 8, 11 |
| POS (`features/pos`, `pos_sales`, `pos_receipts`) | Cashier checkout, discounts, payment methods, receipts (PDF/print/share) | Branch POS with sessions, price/tax snapshot, returns, broad offline queue and sync, receipt numbering unique per location | 7 |
| Receipts (`PFB-YYYYMMDD-NNNN`, random suffix) | Random four-digit suffix | Gap-controlled sequences per legal entity and location, enforced by a database constraint | 4, 7 |
| Super-admin analytics, `pos_analytics`, `admin_performance` | Date-range and state/admin/area filters over orders plus POS | Reporting read models reconciled to the ledger; group and country dashboards; definitions agreed with finance | 10, 14 |
| Notifications (FCM, local notifications, Supabase sender) | Token capture, foreground/background handling, tap navigation | Notification service on a durable outbox; per-user preferences; stale-token cleanup; delivery results retained | 3 |
| Geocoding and maps | `flutter_map`, geolocator, geocoding and routing services | Address validation with stored coordinates for the actual destination; routing for dispatch | 8 |
| CI/CD (GitHub Actions, Firebase Hosting) | Web deploy on push to `main`; several Android workflows | Required-CI main branch, separate dev/staging/production, migrations with rollback plan, signing material only in protected CI secrets | 15 |

### New in Mudatex (not in PFB)

Multi-company and multi-country structure, inventory ledger with rolls and warehouses, procurement, wholesale accounts and credit, integrated double-entry accounting, full manufacturing (BOM, routings, work orders, WIP), quality holds, audit and approvals, Sakash data migration. See spec §§ 4–13.

## 3. Defects in PFB that Mudatex must not repeat

These are listed in PFB's own technical documentation and verified against its repository layout. Each becomes an acceptance test for the matching Mudatex module.

1. **Client-confirmed payments.** Orders must be fulfilled only after server-verified payment; duplicate and delayed webhooks must not double-fulfil.
2. **Client-embedded function secret.** No shared secret in any client build.
3. **Fixed destination coordinates in order assignment.** PFB passes the centre of Nigeria as the target location. Mudatex stores the geocoded destination and tests distance logic against known coordinates in several regions.
4. **Client-only authorization.** Hard-coded super-admin UIDs and hidden routes are not a security boundary. Direct API calls must be tested for every permission.
5. **Random receipt suffix.** Use database-enforced sequences.
6. **Notification sends from app logic.** Use an outbox with retries.
7. **Committed key material.** PFB's tree contains keystores, `key.properties`, `google-services.json` and key-like text files. Mudatex adds secret scanning to CI before the first feature lands, and these files are never copied.
8. **Very large screens mixing UI and orchestration.** Keep presentation, application logic and data access separate and test the logic.
9. **Unreconciled analytics.** Report totals must reconcile to ledger totals on a known sample.

## 4. Roadmap

Phases follow the spec's go/no-go gates (§ 16). The bullets state which PFB capabilities arrive in each phase.

### Phase 0 — Discovery and architecture spike
- Walk through PFB with its operators and list workflows to keep, change or drop.
- Complete the open ADRs (framework, offline protocol, hierarchy, costing, accounting, deployment).
- Profile Sakash data for migration (ownership matrix, no dual authoritative writer).
- Pick the pilot country and site.

### Phase 1 — Platform foundations
- Identity, scoped roles, organization hierarchy, audit log.
- Product catalogue with units and textile attributes (PFB: products, categories, media).
- CI with secret scanning, synthetic seed data, environments.
- Flutter app shell and responsive web shell with login (PFB: auth, shell, theme, routing).

### Phase 2 — Inventory, procurement, sales/POS and offline foundation
- Stock ledger, rolls, reservations, transfers, counts.
- POS with receipts, discounts, payment methods and offline queue (PFB: POS).
- Sales orders with validated status transitions (PFB: orders).
- Notification outbox (PFB: notifications).

### Phase 3 — Wholesale, delivery and integrated accounting
- Customer checkout with server-verified payments (PFB: cart, Paystack) plus country payment adapters.
- Fulfilment and order routing (PFB: assignment, escalation, reassignment, tracking).
- Wholesale credit, AR/AP, general ledger, tax, currencies.
- Group and country analytics reconciled to the ledger (PFB: super-admin analytics).

### Phase 4 — Manufacturing and production costing
- BOM, routings, work orders, WIP, quality, costing (after finance signs off on costing).

### Phase 5 — Country rollout and optimization
- Country-by-country tax, documents and UAT; customer and supplier portals; forecasting; DR rehearsal.

## 5. Open questions for the owner

1. Which countries does Mudatex operate in today, and which one is the pilot?
2. Which PFB workflows are in daily use and must survive unchanged (for example, admin coverage-based assignment)?
3. Will Mudatex run alongside Sakash during migration, and for how long?
4. Who is the finance decision owner for inventory costing and the chart of accounts?
5. Is the first customer-facing channel mobile, web or both?

## 6. Basis and limits

Built from PFB's `README.md`, `docs/TECHNICAL_DOCUMENTATION.md`, its file tree and `pubspec.yaml` at the default branch, plus this repository's specification. PFB's source code was not run, built or tested for this document, and its behaviour is described as documented there. Nothing here means any Mudatex module has been implemented.
