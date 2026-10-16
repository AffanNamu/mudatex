# Sakash Reference Map for Mudatex

Sakash is used as a workflow and migration reference only. Mudatex is a new platform with a separate backend, schema, credentials, deployment and security boundary.

| Sakash capability observed | Mudatex destination | Reuse policy |
|---|---|---|
| Product catalogue, categories and images | Product information management | Reuse business concepts; redesign for variants, units, textile attributes, legal-entity scope and lifecycle. |
| Customer authentication and profiles | Enterprise identity and customer records | Do not reuse client-only role checks; server must enforce scope. |
| Cart, checkout and customer orders | Commerce and order management | Add quotes, partial fulfilment, wholesale price lists and approval controls. |
| POS checkout, discounts and receipts | Branch POS and sales | Preserve cashier workflow concepts; add offline queue, device policy, idempotency and session reconciliation. |
| Paystack initialization and payment attempts | Payment adapter and reconciliation | Do not trust client return as payment proof; verify server-side with provider/webhook and idempotency. |
| Order assignment, delivery tracking and location utilities | Fulfilment and distribution | Replace fixed national-center assumptions with configured addresses/sites and validated coordinates. |
| Admin and super-admin dashboards | Scoped enterprise workspace | Replace hard-coded UID lists with server-authorized roles, scope grants and audited approvals. |
| Firebase/Firestore collections | Migration source mappings | Profile, clean and reconcile; do not copy collections as the new domain model without validation. |
| Firebase notifications | Notification/outbox module | Notifications follow committed business events; they are not proof of transaction success. |
| Legacy rides data | Assess against delivery domain | Import only if owners confirm it is active, meaningful and appropriate. |

## New-system guardrails

- No shared secret embedded in mobile or browser code.
- No payment success inferred from redirect, screenshot or client callback.
- No client-only super-admin authorization.
- No fixed national-center coordinates used instead of a customer's or branch's location.
- No silent overwrite of balances or destructive migration of production records.
- No copying Sakash signing material, provider secrets or production configuration into Mudatex.

## Migration contract

Every imported record must include a source system, source record ID and import batch reference (or equivalent mapping ledger). Every transform defines its missing-value behavior. Migration is repeatable and idempotent, with record-count, stock, order, payment and financial reconciliation reports. During parallel run, each domain has one authoritative writer.
