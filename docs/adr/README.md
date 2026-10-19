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
