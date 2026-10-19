# Mudatex — Initial Engineering Decision Records

This file is a starter register. Each decision should be created as an individual ADR under `docs/adr/` before implementation relies on it.

| ADR | Decision | Status | Required evidence / approver |
|---|---|---|---|
| [001](001-backend-framework-and-database.md) | Backend framework and primary database | Proposed: TypeScript/Fastify modular monolith + PostgreSQL (implemented in Phase 1; validate in spike) | Engineering spike, deployment/ops fit, team skill, transaction test |
| 002 | Offline command and synchronization protocol | Open | POS/warehouse workshops, disconnected-site conflict prototype, security review |
| 003 | Organization hierarchy and permission scoping | Proposed: legal entity and location scope enforced server-side | Finance/legal and security review |
| [004](004-inventory-ledger.md) | Inventory ledger, reservations and movement states | Proposed: immutable movement ledger and transactional reservation (implemented; awaiting sign-off) | Inventory controller signoff and concurrency tests |
| 005 | Inventory costing method | **Open/blocking for valuation** | Qualified finance/accounting decision for all applicable jurisdictions |
| 006 | Accounting functional currency, multi-currency and posting model | Open | Chart of accounts, tax, exchange rates and close policy approval |
| 007 | Manufacturing model and costing | Open | Production-process workshops; BOM/routing/WIP/overhead policy |
| 008 | Country/localization and data residency | Open | Actual operating-country list and jurisdiction-specific advice |
| 009 | Deployment, backup, RPO/RTO and monitoring | Open | Business impact assessment and restore/disaster-recovery exercise |
| 010 | Sakash data ownership and parallel migration boundary | Proposed: no dual authoritative writer | Source profiling, ownership matrix and reconciliation rehearsal |
| [019](019-web-console.md) | Web console (React) and its rules for money, retries and permissions | Proposed (implemented for sign-in, catalogue, stock, POS, payment confirmation, access view) | Real identity provider; offline decision; user feedback |
| [018](018-sakash-migration.md) | Migration from Sakash (PFB) | Proposed (tooling built, untested on real data) | Run the rehearsal on real data; business sign-off on cutover plan |
| [017](017-pos-revenue-posting.md) | Automatic drafting of POS revenue journals | Proposed (implemented, off by default) | Accountant review of accounts, timing and tax treatment |
| [016](016-event-outbox.md) | Event outbox, webhooks and internal consumers | Proposed (implemented) | Security review of the webhook surface |
| [015](015-manufacturing-and-quality-holds.md) | Manufacturing (quantity side) and quality holds | Proposed (implemented; costing gated on 005/007) | Production-process workshops; quality-team review |
| [014](014-general-ledger-core.md) | General ledger core: journals, periods, exchange rates, reversals (mechanics only) | Proposed (implemented; policy still blocked on 005/006) | Qualified accounting review; chart, tax and costing decisions |
| [013](013-procurement.md) | Procurement: purchase orders, receiving, supplier returns | Proposed (implemented; needs procurement/finance review) | Procurement and finance sign-off; quality and payables follow-ups |
| [012](012-pos-pricing-tax-and-payments.md) | POS pricing, tax snapshots, rounding and payment verification | Proposed (implemented; needs finance/tax review) | Finance and local tax-adviser approval; offline scope from ADR 002 |
| 011 | Product baseline: PFB feature parity on the enterprise backend, no PFB code copied | Proposed by owner direction | Owner confirmation; workflow review with PFB operators |

## ADR template

- **Title / status / date / decision owner**
- **Context and business drivers**
- **Options considered**
- **Decision and rationale**
- **Consequences and trade-offs**
- **Security / reliability / migration impact**
- **Evidence and tests**
- **Revisit trigger**
