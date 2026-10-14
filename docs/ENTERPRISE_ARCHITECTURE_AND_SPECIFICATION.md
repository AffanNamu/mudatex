# Mudatex Enterprise Platform — Architecture & Product Specification

**Status:** Baseline specification for discovery and implementation planning  
**Repository:** https://github.com/AffanNamu/mudatex  
**Business scope:** International retail, wholesale, distribution, integrated accounting, and full manufacturing  
**Expected internal users:** Initial planning range of 100–500; architecture must permit growth  
**Legacy reference:** Sakash Collection is a separate existing application and potential migration source. This new project does not depend on or automatically copy its implementation.

## 1. Executive intent

Build a reliable, secure, multi-company and multi-country enterprise platform for Mudatex. It should support central and branch warehouses, textile-specific inventory, retail POS, wholesale accounts and pricing, procurement, cross-location distribution, integrated double-entry accounting, and manufacturing from bills of materials through work orders and production costing.

The work must start in this clean repository. Sakash should be inspected separately to understand existing workflows and source data, but code, credentials, application identities, cloud resources, and schema must not be copied blindly. The new platform owns its own architecture and can import approved legacy data through repeatable migration tooling.

### Key decisions recorded

| Decision | Direction |
|---|---|
| New repository | Implement in `AffanNamu/mudatex`; do not treat Sakash as the codebase |
| Geography | Support all current operating countries discovered during business discovery; design for additional countries |
| Offline | Broad offline capability for agreed POS and operational workflows with explicit conflict policy |
| Migration | Parallel transition, reconciliation, controlled cutover, rollback/recovery |
| Manufacturing | Full manufacturing scope, including BOMs, routings, work orders, WIP and production costing |
| Inventory costing | **Undecided**. Do not hard-code a costing method or post production financials until finance signs off |
| Accounting | Integrated double-entry accounting and subledgers |
| Organization | Multi-company/legal entity, country, branch, warehouse, storage location, department and cost-centre scoping |

## 2. Product boundaries and personas

### Core experiences
1. **Enterprise web workspace:** Group/country executives, finance, procurement, product management, sales operations, HR/admin and auditors.
2. **Branch POS and sales workspace:** Cashiers, branch managers and retail sales teams, with controlled offline support.
3. **Warehouse and production workspace:** Receivers, pickers, inventory controllers, production planners, machine/work-centre operators and quality inspectors.
4. **Wholesale/distribution workspace:** Account managers, order desk, dispatch, drivers or delivery partners.
5. **External portals (later phases):** Customer/wholesale accounts and supplier collaboration.

### Primary roles
Group administrator; country manager; branch manager; warehouse manager; inventory controller; cashier; retail/wholesale sales representative; account manager; procurement officer; supplier; production planner; production operator; quality inspector; finance officer; accountant/controller; auditor (read-only); dispatcher/driver; customer. Roles must be composable permissions scoped to authorized legal entities, countries and locations—not a single global admin flag.

## 3. Target architecture

### Architectural style
Start with a **modular monolith** behind a versioned server API, plus durable asynchronous workers for notifications, integrations, reports and other tasks that do not need to run in the critical transaction. Split services only when proven scaling, deployment, security-isolation or ownership requirements justify the additional operational cost. Avoid premature microservices.

### Logical view

```text
Flutter/mobile POS & operations      Responsive enterprise web      External portals
             |                                   |                          |
             +------------------- Versioned API / identity ----------------+
                                                 |
    +-------------------- Domain modules / application services -------------------+
    | Org & IAM | Catalog/PIM | Inventory | Procurement | Sales/POS | Wholesale      |
    | Finance   | Distribution | Manufacturing/MRP | Quality | Reporting | Audit     |
    +------------------------------------+--------------------------------------------+
                                         |
             +---------------------------+-------------------------------+
             |                           |                               |
      Transactional DB            Durable job/event outbox         Object storage
      (PostgreSQL proposed)        + workers/retries                documents/media
             |
      Read models / reporting snapshots / exports
```

### Technology decision policy
- **Primary transactional database:** PostgreSQL is the preferred candidate because inventory, manufacturing, finance and concurrent posting require relational integrity and atomic transactions. Final choice follows a short architecture validation spike; do not create duplicate sources of truth.
- **Backend:** Choose a maintainable, typed server framework after a small proof-of-concept comparing team proficiency, authentication integration, transaction patterns, offline sync, test tooling and operational cost. Record the decision in an ADR. No framework should be assumed by documentation alone.
- **Client:** Flutter can serve POS and warehouse mobile workflows; use a responsive web application for desktop-first finance, management and planning. The final division follows device and workflow testing.
- **Identity:** Support enterprise role/scoped authorization and secure token verification. A managed identity provider can be selected, but authorization is enforced server-side.
- **Offline local store:** Use a transactional local database on supported clients, encrypted device storage where the platform supports it, durable operation queues, schema versions and sync cursors.
- **Object storage:** Store files, documents and media outside the relational database, with short-lived signed access, malware/content checks where appropriate, and retention controls.
- **Background processing:** A durable outbox and retryable workers for notifications, webhooks, exports, integrations and reporting. Exactly-once delivery cannot be assumed; design at-least-once delivery plus idempotent consumers.
- **Deployment:** Separate development, test/staging and production environments; infrastructure as code where practical; CI/CD with review gates, migrations and rollback plans.
- **Legacy services:** Sakash services remain external during discovery/parallel operation. Integrate through controlled import/export/API boundaries only when necessary and documented.

### Domain-module ownership
- Identity and Organization: organizations, legal entities, countries, branch/location tree, membership and permissions.
- Product Information: SKU, variant, unit, textiles metadata, barcode and price lists.
- Inventory: stock ledger, reservations, availability, lots/rolls, transfers, counts, stock valuation interface.
- Procurement: supplier, requisition, purchase order, receiving, inspection, supplier invoice and return.
- Commerce: customer, quote, sales order, POS session, invoice, return/refund request, promotions.
- Fulfilment: pick, pack, dispatch, shipment, delivery attempts, proof of delivery and returns logistics.
- Finance: general ledger, accounts receivable/payable, cash/bank, tax, payments, currency/exchange rates, periods and reconciliation.
- Manufacturing: BOM/version, routing, work centre, resource/calendar, production order, material issue/return, WIP, output, scrap/by-product, subcontracting as confirmed, costing and variance.
- Quality: inspection plans, hold/quarantine, nonconformance, corrective action and release.
- Shared platform: audit, approvals, documents, notifications, integration registry, job execution and reporting.

## 4. Enterprise organization, currencies and country configuration

Each transaction must be scoped to a legal entity and the relevant operating location. Define a configurable hierarchy of group → legal entity → country operation → branch/warehouse/storage location, while allowing a legal entity to operate multiple locations in a country. Do not assume country and legal entity are interchangeable.

Support:
- Functional, transaction and reporting currencies; decimal precision and rounding rules per currency.
- Effective-dated exchange rates with source and approval metadata.
- Local time zone, business date, fiscal calendar, invoice sequence and legal document rules.
- Tax codes/rates and tax reporting configuration per jurisdiction, approved by local accounting/tax advisers.
- Country-specific payment rails and provider adapters.
- Country/region access scopes and explicit cross-border permission.
- Intercompany sale/transfer treatment where entities are legally separate.
- Retention, privacy and data-residency decisions per applicable jurisdiction.

A record's original transaction currency, exchange rate, functional-currency equivalent, legal entity, posting date and audit history must remain available after posting. Consolidated reporting must disclose the rate/translation policy and the handling of intercompany balances.

## 5. Product catalogue and textile units

### Product and variant fields
Stable product ID; SKU; one or more barcodes; title/description; category; brand; images/documents; supplier references; active/archived state; tax category; product variants; base unit of measure; allowed purchase/sale/production units; conversion definitions; dimensions/weight where relevant; reorder parameters; batch/lot/roll tracking policy; country availability; effective-dated price lists.

Textile attributes may include fabric family, pattern/design, colour, width, composition, collection and supplier design code. These attributes must be configurable rather than an inflexible list for every product category.

### Units and conversion
Support discrete and decimal quantities. Examples include metre, yard, roll, piece, bundle, carton and kilogram where relevant. Conversions belong to a product/package or explicitly approved conversion rule; never assume every roll has the same length. Define measurement precision and rounding before production.

For a roll initially containing 100 yards, sales of 7.5 and 12 yards leave 80.5 yards. If the roll is physically split, maintain lineage from parent roll to child roll(s), including quantities and locations. Batch/roll labels and scan flows should be supported.

**Acceptance:** No implicit unit conversion; invalid precision rejected or handled under explicit rounding policy; roll splits conserve quantity; unique barcodes/SKUs follow defined uniqueness scope; archived products remain readable in historical documents.

## 6. Inventory and warehouse management

### Stock states
Track on-hand, available, reserved, picked, in-transit, quarantined/inspection hold, damaged, returned-pending-inspection and scrapped/disposed quantities as appropriate. Define the formula for availability explicitly; quantities in distinct states must not be double-counted.

### Workflows
- Purchase order → goods receipt → inspection/quarantine if needed → accepted stock.
- Transfer request → submit → approval (policy-based) → pick → dispatch → in transit → destination receipt → discrepancy resolution.
- Sales reservation → pick/pack → dispatch/sale completion according to channel policy.
- Count planning → count blind/controlled → variance → reason → approval → compensating adjustment.
- Return authorization → receipt into quarantine → inspection → restock/refurbish/scrap → credit/refund disposition.
- Lot/roll traceability from receipt through split, transfer, production consumption, sale and return.

Use an immutable stock movement ledger. Maintain current balance projections transactionally or rebuildably; never fix a ledger discrepancy by manually editing a balance without a supporting movement. Lock or otherwise serialize competing allocations so simultaneous sales cannot over-allocate stock.

### Costing decision gate
The inventory costing method is deliberately **not selected**. Finance must compare and approve permissible methods, applicable accounting standards, tax/accounting implications, roll/lot traceability, manufacturing WIP, returns, landed cost, cross-entity transfers and multi-currency valuation. Candidate methods for assessment include weighted average and FIFO; specific identification may be relevant where cost is traceable to unique rolls/batches or manufacturing lots. Availability differs by jurisdiction and product and must be confirmed by the accountant.

Before selection:
- Implement movement quantities and lineage independently of final monetary valuation method.
- Define a cost-engine interface and preserve the provenance of receipts, landed costs, production consumption and returns.
- Do not silently mix methods within an entity/valuation scope.
- Do not post live inventory valuation or production variances using placeholder costs.
- Keep valuation method and effective date explicit in configuration/ADRs; changing an established method requires finance approval, prospective policy and/or controlled revaluation plan.

**Acceptance:** Concurrent reservations cannot oversell; duplicate transfer/receipt requests do not duplicate movements; every adjustment has reason and approval; balance projections reconcile to ledger; in-transit quantities reconcile between source, transit and destination; costing reports are blocked from financial use until the policy is approved and tested.

## 7. Retail POS and broad offline capability

### POS functions
Barcode scanning, variants, location-specific availability, price lists, tax, discount limits, customer selection, cash/card/bank/electronic payment recording, receipt/invoice, hold/resume sale, controlled return/refund, cashier session opening/closing, cash count, payment settlement reconciliation and shift reports.

### Offline policy
Offline mode is not a second authoritative server. Each offline client records durable, versioned, signed-in-user operations in an encrypted local store, with stable UUIDs/idempotency keys, event timestamps, server acknowledgement state, device/site metadata, and a monotonic local sequence. On reconnect it sends pending operations in order where required; the server validates permissions, policy, catalog/price version, operation uniqueness and current business state before accepting.

Define these separate capabilities:
- **May be allowed offline:** browse a cached catalog; draft quotations/orders; record a POS sale against a pre-provisioned, bounded offline allowance; scan/count stock; capture receipt/dispatch evidence; queue selected warehouse actions.
- **Usually online-required unless policy explicitly allows a controlled exception:** intercompany postings, cross-border transfers, supplier bank-detail changes, account/permission administration, period close, final accounting journals, high-value refunds, credit overrides and external payment confirmation.
- **Payments:** offline card/instant transfer status must never be inferred from a client screenshot. Card terminal offline behavior depends on the provider/acquirer policy. Queued payment instructions are pending until verified.
- **Stock conflicts:** Offline sites cannot know about competing sales at other locations. Define per-device/per-branch offline stock pools or safety allocations, conservative cached availability, transaction limits, and a manual conflict queue. No global no-oversell promise while multiple disconnected sites can sell the same unconstrained pool.
- **Pricing/tax:** Cache signed/versioned policy snapshots with expiry; after expiry, restrict or escalate high-risk sales as defined.
- **Devices:** Enforce device enrollment, user sessions, local data retention, remote revocation where feasible and a clear lost-device procedure.

The server must be authoritative on final acceptance; clients show queued, synchronized, rejected or needs-review states. Never silently discard a queued transaction. Rejected operations must preserve the original payload and provide a controlled resolution path.

### Offline acceptance tests
1. Kill the app/power during a transaction; on relaunch, the operation is recoverable or clearly marked incomplete, never silently lost.
2. Replay an operation 10 times; only one sale, inventory effect, payment allocation and journal may be created.
3. Disconnect for the maximum approved offline window, perform the allowed transaction volume, reconnect and synchronize without missing accepted operations.
4. Two devices sell against the same constrained offline allowance; acceptance follows the designed quota/conflict rule, with no silent negative stock.
5. Revoke a user/device while online; subsequent server sync rejects disallowed work and exposes it for review without erasing records.
6. Expired price/tax cache follows the specified block/warning/approval rule.
7. Payment awaiting server/provider verification does not mark the order as paid or release stock in a way contrary to policy.
8. Out-of-order, corrupt or schema-old events are quarantined or migrated deterministically and are observable to support staff.

## 8. Wholesale, procurement and distribution

### Wholesale
Customer accounts, business identity/tax fields, delivery addresses, negotiated and tiered price lists, quotations/pro forma, credit terms/limits, order approval, reservation, partial fulfilment, backorders, deposits, partial invoice/payment allocation, statement, return/credit note and account manager assignment.

Block or require approval for credit-limit breaches, overdue accounts, below-margin sales and unauthorized overrides. A customer's pricing/credit terms are never exposed to another customer.

### Procurement
Supplier master, requisition and approval, purchase order, goods-received note, quality/quantity inspection, supplier invoice matching, price/quantity tolerances, supplier return, landed costs (freight, insurance, duty, handling), payment proposal and supplier statement reconciliation. Supplier bank details require restricted changes and independent approval.

### Distribution
Picking/packing, shipment and manifest, carrier/driver assignment, route/tracking integration where selected, proof of delivery, partial/failed delivery, reschedule, return-to-warehouse, freight allocation and customer status notifications. Dispatch and delivery retries must be idempotent and linked to the order.

**Acceptance:** Partial shipments preserve outstanding quantity; credit checks use current authorized data; purchase invoice tolerances trigger holds; delivery failure does not duplicate invoices or deduct stock twice; supplier/customer subledger and movement records reconcile.

## 9. Full manufacturing requirements

Manufacturing is in scope and cannot be treated as a later optional feature without architecture support. Implement it in controlled increments after the product, inventory, costing and accounting foundations are established.

### Master data
- **Bill of materials (BOM):** versioned output product, components, quantities, units/conversions, expected yield, scrap/by-product rules and effective dates.
- **Routing:** ordered operations, work centres, standard setup/run times, labor/machine requirements and quality checkpoints.
- **Work centres/resources:** capacity calendars, shifts, downtime and maintenance constraints where in scope.
- **Production parameters:** batch size, planned yield, tolerances, traceability policy, subcontractor operations if required.
- **Quality:** inspection plans, sampling rules, nonconformance, rework and release/quarantine.

### Manufacturing workflows
1. Plan demand from forecast, confirmed orders, reorder policy and available inventory.
2. Run material requirements planning (MRP) to calculate component needs, existing supply, lead times and shortages.
3. Create and release a production/work order against a specific BOM and routing version.
4. Reserve/allocate materials and identify relevant batch/roll lots.
5. Issue materials to production; allow approved substitutions only through controlled BOM/order changes.
6. Record operation start/stop, labor/machine consumption, quantities completed, scrap, defects and downtime as selected.
7. Put unfinished material into work in progress (WIP) and apply cost under approved accounting policy.
8. Inspect, release, reject or route output to rework.
9. Receive finished/semi-finished goods into inventory with lot/batch genealogy.
10. Close the work order, calculate cost/variance under the approved method and reconcile material, labor, overhead, scrap and output.

### Production types
Discover actual operation before choosing process features. Support configurable discrete/batch production initially. If textile finishing, dyeing, cutting, tailoring or continuous/process manufacturing is required, document process-specific routing, yield, by-products, shade/lot controls and quality checks. Do not assume that every textile operation is the same.

### Material and quality traceability
For a finished batch, trace all consumed material lots/rolls and operations. For any material lot, identify all work orders and finished goods that consumed it, plus shipments/customers if sold. Preserve roll lineage where fabric is cut into multiple pieces. Hold nonconforming material from normal availability until authorized release.

### Manufacturing costing gate
Full production cost reporting depends on finance approving inventory costing, valuation of WIP, labor and machine rates, overhead allocation, scrap/by-product treatment, rework and variance accounting. Before policy approval, develop physical workflows and quantity reconciliation, but do not publish official unit cost, WIP valuation or production P&L from placeholder assumptions.

### Manufacturing acceptance
- A released work order reserves/allocates only eligible inventory and identifies shortages.
- BOM and routing versions are frozen or explicitly revision-controlled once production starts.
- Material issue cannot exceed available/reserved amounts without approved exception.
- Component quantities, output, scrap, by-products and yield reconcile to configured tolerance.
- Lot/roll genealogy can trace both backward (finished output to input material) and forward (input lot to affected output).
- Quarantined/nonconforming material cannot be consumed or sold without explicit authorized disposition.
- Duplicate work-order issue/completion messages do not duplicate stock movements.
- Work-order closure produces a material and quantity reconciliation report; financial closure remains gated on approved costing policy and balanced postings.

## 10. Integrated accounting

### Core functions
Chart of accounts; legal-entity functional currency; general ledger; fiscal periods; journal approval/posting/reversal; AR/AP; customer invoices/receipts/credit notes; supplier bills/payments/debit adjustments; cash/bank; bank/payment reconciliation; tax codes and jurisdictional reports; inventory valuation and COGS; WIP and production variance accounts; intercompany transactions; fixed assets as scoped; trial balance, profit and loss, balance sheet, cash flow and management dimensions.

### Hard controls
- Double-entry: every posted journal has total debits equal to total credits at configured currency precision.
- Operational event posting uses centrally defined, versioned, tested posting rules.
- Posted journal lines are immutable; corrections use reversals/adjustments linked to the source.
- Closed periods reject unauthorized backdated entries.
- Receipts can be partially allocated or unapplied under policy; reallocation is auditable.
- External payment status requires provider/server verification; webhooks are signature-verified and idempotent.
- Inventory, WIP and production variance postings are disabled for production until the costing policy is approved.
- Taxes and statutory documents are configured per entity/jurisdiction and reviewed by qualified advisers.
- Intercompany entries and consolidated reports have explicit rules for separate legal entities.

### Required reconciliation
Trial balance balances; balance sheet equation balances; AR/AP subledgers reconcile to control accounts; payment provider/bank settlements reconcile to internal payment transactions; inventory valuation reconciles to the inventory control account; WIP and manufacturing variance reconcile to closed/open work orders under the approved policy; intercompany balances are matched and differences surfaced.

## 11. Security, privacy and audit

- Central server-side authentication and authorization on every protected action. UI hiding is not security.
- Company/country/branch/warehouse scope must be checked server-side and included in queries.
- Maker-checker for high-risk financial and stock operations, with configurable limits and prohibition of self-approval where required.
- Least privilege, privileged-user MFA where supported, staff offboarding and token/session revocation processes.
- Secrets only in a managed secret store; no privileged secrets in mobile/web bundles or source control.
- Payment provider status verified at server/webhook; signature, replay, amount, currency, merchant and order reference verified.
- TLS in transit; encryption at rest and protected backups; minimal sensitive data on devices.
- Audit of access/role changes, prices, discounts, stock adjustments, receipts, transfers, returns/refunds, supplier bank changes, journals, period close/reopen, data exports and configuration.
- Audit records include actor, event time, scope, action, entity ID, result, reason where required, correlation ID and before/after diff where appropriate; never log passwords, bearer tokens or payment secrets.
- Retention, deletion, data-subject access and data residency policies must be configured per applicable country law and legal review.
- Security testing includes direct API manipulation, cross-tenant requests, privilege escalation, replay, rate limiting and file-access controls.

## 12. Data model and invariants

Logical entities (implementation may group or normalize differently):
- Organization: group/company/legal entity/country/branch/warehouse/bin/cost centre.
- Identity: user, role, permission, scope grant, device, approval policy.
- Catalog: product, variant, SKU, barcode, UOM, conversion, lot, roll, BOM, routing.
- Inventory: movement ledger, balance projection, reservation, transfer, count, adjustment, valuation layer.
- Procurement: supplier, requisition, PO, receipt, inspection, supplier invoice/return.
- Sales: customer, price list, quotation, order, line, POS sale, invoice, return, credit note.
- Payments: payment instruction, provider transaction, receipt, refund, allocation, reconciliation.
- Distribution: pick, package, shipment, delivery attempt, proof of delivery.
- Manufacturing: production plan, MRP run, work order, material issue/return, operation report, WIP, output, scrap, genealogy, variance.
- Finance: account, journal, journal line, fiscal period, tax code, exchange rate, bank statement, reconciliation.
- Shared: approval, audit event, document metadata, outbox/integration event, notification, import batch, sync cursor.
- Reporting: read models, snapshots, definitions, freshness metadata.

Invariants:
1. Posted inventory movements and journal lines are immutable.
2. Stable IDs and idempotency keys guard retried requests and external events.
3. Product quantities use explicit units and precision.
4. A user may only act within authorized scope.
5. Every posted journal balances.
6. State transitions are validated server-side.
7. Financial and inventory balances can be reconciled/rebuilt from authoritative records.
8. Historical references remain intact; product/customer archival is preferred over destructive deletion.
9. Events/notifications are not treated as proof of a transaction unless the underlying authoritative transaction succeeded.
10. No second writer may independently modify an authoritative inventory or finance balance.

## 13. Sakash migration and parallel operation plan

The new repository is independent. Sakash must not become a runtime dependency by accident, and no source production data should be altered during migration.

### Step A — Discovery and source profiling
- Inventory Sakash repo, environments, schemas, collections, functions, integrations and data owners separately.
- Map existing user identity, product/catalog, unit, stock, sales/orders, receipts/payments, customers/suppliers, roles and documents.
- Identify ambiguous status meanings, duplicate references, missing timestamps, fixed-location behavior, old/unused collections and sensitive information.
- Define data ownership and legal basis/permissions for each data set before export.
- Do not import live credentials, keystores, API secrets or irrelevant personal data.

### Step B — Canonical mapping and migration contract
For every source field define target field, transformation, default/unknown behavior, key mapping, validation, reconciliation group, owner and error handling. Preserve source IDs as legacy references, not necessarily target primary keys. Maintain `legacy_source`, `legacy_record_id`, and `import_batch_id` or an equivalent mapping ledger where appropriate. Produce versioned mapping files and scripts in the new repo.

### Step C — Clean, rehearse, compare
- Export only authorized data through approved, access-controlled means.
- Normalize SKUs, barcodes, textile units, currencies, dates and references with an exception report; never guess silently.
- Import into an isolated staging environment; rerun the migration repeatedly to prove idempotency.
- Reconcile record counts, referential integrity, stock quantities by item/location/lot, open order totals, payment/provider references, AR/AP, opening trial balance, inventory value and roll/lot lineage where source data exists.
- Record every transformation, rejected row and manual resolution with approvals.
- Get data-owner and finance sign-off.

### Step D — Parallel run
- The new platform and legacy Sakash can both be used for comparison, but define one authoritative writer per domain at a time.
- Before cutover, the legacy system remains authoritative for production transactions not formally migrated. The new system may run in read-only/shadow mode, accept test transactions, or transact within a pilot scope that is explicitly ring-fenced.
- Avoid dual writes to the same inventory or financial scope. If a temporary dual-feed is necessary, use a durable, idempotent integration contract and reconciliation.
- Compare sales, payments, stock movement, purchase receipt, production (if any), and financial summaries on agreed intervals. Every difference gets an owner, reason and resolution.
- Parallel operation must include staff training and a clear support/escalation process.

### Step E — Cutover
- Agree freeze window, final delta extraction, idempotent import, identity mapping, opening balances, last legacy document numbers and transaction cutoff.
- Take and verify pre-cutover backups/exports.
- Validate post-import smoke tests and all reconciliation reports before write access is enabled.
- Switch a bounded pilot country/location/channel first, then expand using repeatable playbooks.
- Maintain a rollback plan that says precisely which system is authoritative, how new transactions will be preserved, and when rollback becomes unsafe because irreversible external payments or documents have occurred.
- Do not delete or immediately decommission Sakash history. Preserve read-only access and retention in line with business/legal policy until formally retired.

### Step F — Stabilize and retire
Monitor discrepancies, sync queues, user reports, ledger reconciliations and performance. Retire Sakash integrations only after the last required data, reporting and audit dependencies have been signed off. No fixed retirement date without evidence.

### Migration acceptance criteria
- Import scripts are repeatable and idempotent in staging.
- 100% of in-scope records are imported or listed in an approved exception register; no silent row loss.
- Stable legacy-to-new mappings exist for in-scope records and support traceability back to source.
- Counts and amounts reconcile to approved tolerances, with all residual variances reviewed and signed off.
- Inventory quantities reconcile by company/location/SKU/unit/lot; monetary valuation remains gated until method and opening valuation are approved.
- Customer and supplier outstanding balances, payment references, open orders and opening general-ledger balances reconcile to signed-off source snapshots.
- Parallel comparison has no unresolved critical discrepancy for the configured pilot period.
- Rollback/recovery has been rehearsed against a representative test environment.
- Data exports, files and backups are encrypted, access controlled and have documented retention/deletion.

## 14. Reliability and performance targets

These are proposed starting objectives requiring confirmation via business impact assessment and load tests:
- Core online-service availability: 99.9% monthly target.
- Typical read API latency: p95 < 500 ms under the agreed load, excluding external provider and heavy-report latency.
- Common online writes: p95 < 1 second where practical, excluding provider round-trips.
- RPO: target no more than 15 minutes for the primary data system; define stricter requirements for critical financial transactions.
- RTO: core service restored within 4 hours after qualifying disaster.
- Backups monitored continuously; restore drill at least quarterly and before major cutovers.
- Alert on failed accounting postings, payment mismatch, sync backlog, inventory reconciliation variance, queue retries/dead letters, backup failures, unusual admin access and high error/latency rates.

Build for failure: transaction timeouts; bounded exponential retries with jitter; idempotency; durable outbox; poison-message isolation; database connection limits; rate limits; dependency timeouts; degraded read-only modes where safe; runbooks; incident review. Reports should use indexes/read models/snapshots and not block operational writes.

Performance/load tests must model peak concurrent users and transaction rates based on actual measurement, not just 100–500 registered accounts. Include POS bursts, multiple warehouse scans, production reporting, end-of-day postings and concurrent transfers.

## 15. CI/CD and engineering workflow for this clean repo

Create a repeatable, documented repository standard before product modules proliferate:
- `docs/` architecture, ADRs, domain specifications, security model, operational/runbook and migration docs.
- `docs/adr/` for decisions including backend/framework/database, offline sync, inventory costing, multi-entity accounting, manufacturing costing and deployment.
- `db/migrations/` or framework-equivalent versioned schema migration folder; migrations must be reviewed, forward-safe where possible and tested against a representative prior version.
- `tests/` organized into unit, integration, contract, migration, security and end-to-end suites as applicable.
- CI: format/lint, type check, unit tests, database migration validation, integration tests, dependency/security scanning and build/package checks.
- Required peer review, protected main branch, small PRs, release tags, rollback and environment-promotion checks.
- Keep secrets in GitHub/environment secret stores or a managed vault; commit `.env.example` only with placeholders. Never commit production credentials or real customer data.
- Seed scripts use synthetic demo data only.
- Observability: structured logs with correlation IDs, metrics, traces where supported, dashboards and actionable alerts.
- Maintain `README.md`, local setup guide, architecture overview, feature matrix, threat model, test instructions and a clear list of non-goals.

No database, runtime, framework, cloud provider or third-party payment provider is finalized by this document. Record choices in ADRs after a short proof of concept and stakeholder review.

## 16. Delivery phases and go/no-go gates

The calendar estimate is indicative, not a promise. Full manufacturing, international finance and broad offline support are substantial areas; timeline depends on staffing, actual operating countries, process complexity and data quality.

### Phase 0 — Discovery and architecture spike
Deliver current-country/site inventory, stakeholder workflow maps, source data profile, threat model, system context, ADRs for stack and database, offline risk test, accounting policy decision plan, costing decision owners, manufacturing requirements and prioritized backlog.

**Exit:** Business/product/engineering/finance sign off boundaries, architecture risks, pilot country/site, costing decision timetable, offline scope and success metrics.

### Phase 1 — Platform foundations
Repository/CI standards; identity/scoped IAM; organization hierarchy; core product/UOM; audit; migration framework; environment/monitoring; transaction and outbox patterns.

**Exit:** Access control passes direct API tests; CI is required for main; seeded synthetic data; schema deployment and rollback/forward-fix rehearsal pass.

### Phase 2 — Inventory, procurement, sales/POS and offline foundation
Stock ledger; reservations; transfers; receipts; cycle counts; supplier POs; POS, pricing/tax snapshot; local transaction queue; sync/conflict tooling; offline quota policy.

**Exit:** stock movement and offline recovery suites pass; duplicated/replayed messages are idempotent; pilot reconciliation passes.

### Phase 3 — Wholesale, delivery and integrated accounting
Credit rules; partial fulfilment; supplier and customer subledgers; GL/AR/AP; payment adapters; currency/tax config; reconciliation. Finance must finalize chart, tax and initial costing policies before relevant monetary postings go live.

**Exit:** finance signs off journals, opening balances, controls, reports, provider reconciliation, close/reopen and audit tests.

### Phase 4 — Manufacturing and production costing
BOM/routing, MRP, work orders, reservations/issues/returns, operations reporting, QC, WIP/finished goods genealogy, labor/machine/overhead and variance calculations.

**Exit:** manufacturing quantity/yield/genealogy tests pass; finance approves WIP/cost rules; all production postings and inventory valuation reconcile.

### Phase 5 — Country rollout and optimization
Country-by-country tax/localization checks; branches and warehouses; additional portals and integrations; forecasting/BI; performance/cost tuning; security review and DR rehearsal.

**Exit:** every rollout country passes localized UAT, tax/document signoff, permission/access tests, reconciliation and operational support readiness.

## 17. Definition of done and production acceptance

### Release-wide mandatory criteria
- No open critical vulnerability, unauthorized cross-entity access, silent data-loss defect, duplicate payment fulfillment, duplicate inventory movement or unbalanced posted journal.
- All required CI checks and regression suites pass, with code review completed.
- Migration/rollback/recovery has been rehearsed; backups are restorable.
- Logs, metrics, alerts, dashboards and runbooks are usable by the on-call/support owner.
- Pilot users complete real workflows in UAT and sign off.
- Reconciliation reports match approved tolerances; exceptions are documented with owner/date/risk approval.
- Training, access grants, environment configuration and incident communications are ready.
- Feature flags and rollout boundaries can halt new writes safely without corrupting existing transactions.

### Domain acceptance summary
- **Inventory:** movement ledger, stock projections, reservations and physical counts reconcile; transfers are idempotent; concurrent sale tests pass.
- **Offline:** queue survives process/device restart; every operation is accepted/rejected/needs review visibly; retries do not duplicate effects; conflicts have explicit owner and resolution trail.
- **Accounting:** double-entry balance, subledger controls, payment reconciliation, period control and audit all pass; approved costing method applied consistently.
- **Manufacturing:** BOM/routing version control, component availability, issue/return, yield/scrap, QC, genealogy, WIP and variance reconciliation pass.
- **International:** every enabled country has documented functional currency, tax/invoice policy, time zone, fiscal calendar, payment methods and compliance signoff.
- **Security:** token validation, scope enforcement, privilege escalation, replay protection, secret handling, audit access and sensitive document controls pass.
- **Performance/recovery:** agreed peak test passes; RPO/RTO demonstrated in a rehearsal; alerts fire for injected critical failures.

## 18. Open decisions register

These are explicit blockers or decisions, not details to guess in code:
1. List of currently operating countries and legal entities; pilot country/location and rollout order.
2. Inventory costing method and permitted change policy, decided by finance/accountant.
3. Manufacturing process types and products: discrete/batch vs process, fabric cutting/finishing/dyeing/tailoring, yield, scrap, by-products and quality controls.
4. Costing for labor, machine time, overhead, WIP, rework, subcontracting and variances.
5. Offline transaction allowance per branch/device, max disconnected duration, allowed operations and payment terminal policy.
6. No-oversell policy for disconnected branches: quotas, reserved pools or allowed exception/negative stock.
7. Chart of accounts, tax treatment, functional currency, exchange-rate source, fiscal calendar and period-close policy per entity.
8. Bank/payment providers and settlement data access in each country.
9. Expected peak transactions/concurrency, POS/device and barcode-printer/scanner hardware.
10. Data retention, residency, backup region and disaster recovery obligations.
11. Authoritative data domain and interim operation of each Sakash workflow during parallel migration.
12. Reporting and group consolidation needs, including intercompany trade and elimination rules.

## 19. First execution backlog

1. Record business stakeholders and create workshops for finance, warehouse, wholesale, retail, procurement, manufacturing, delivery and IT.
2. Add repository standards, issue templates, PR checklist, CI skeleton, `.env.example` and synthetic seed-data policy.
3. Write ADR-001 (backend/database candidates), ADR-002 (offline sync and quota policy), ADR-003 (organization and authorization scope), ADR-004 (inventory ledger), ADR-005 (costing decision process), ADR-006 (accounting and multi-currency), ADR-007 (manufacturing model).
4. Build a small end-to-end vertical proof: authenticate a scoped user, create a product, receive stock, reserve/sell once, record an auditable movement, synchronize an offline queued draft, and prove duplicate replay does not duplicate inventory.
5. Profile Sakash data and prepare the first versioned migration mapping; do not import real data into development.
6. Create the first domain model and test harness before broad UI implementation.
7. Establish pilot success metrics and go/no-go owners.

## 20. Final architectural rule

Make **authoritative transaction handling, stock traceability, offline safety, double-entry accounting and manufacturing genealogy** foundational design constraints. Do not allow screens, reports, offline devices, payment callbacks or integrations to become independent sources of truth. Build in vertical slices with automated tests and reconciliation at every boundary.
