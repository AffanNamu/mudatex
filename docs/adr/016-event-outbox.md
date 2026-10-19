# ADR 016 — Event outbox, webhooks and internal consumers

- **Status:** Proposed (implemented in `apps/api`).
- **Date:** 2026-10-19

## Decisions
1. **Transactional outbox.** `domain_events` rows are inserted by the audit helper in the same transaction as the audited change, so events and changes cannot diverge. Events are append-only (the only permitted update is the fan-out marker).
2. **Thin events.** An event names the action, the aggregate type and id, the actor and the request id. It carries no business fields, so a webhook subscriber or a bug cannot leak data the subscriber is not entitled to, and event shapes rarely change. Subscribers read state through the authorized API.
3. **At-least-once, unordered delivery** with the event id as the idempotency key. This matches the spec's rule that exactly-once cannot be assumed.
4. **One delivery table for webhooks and internal consumers**, with retries, a lease for crash recovery (`locked_until`), `SKIP LOCKED` claiming so several workers can run, exponential backoff with jitter, a dead-letter state, and manual re-queue.
5. **HTTP is never done inside a database transaction.** A delivery is claimed and leased, then attempted, then settled.
6. **Signed requests** (HMAC-SHA256 over timestamp and raw body), secrets encrypted at rest with AES-256-GCM under a server key, shown once at creation, rotatable.
7. **SSRF controls**: https only, no credentials in URLs, every resolved address must be public, re-checked on every delivery, redirects not followed. Plain http and private targets exist only behind explicit development flags that production refuses to start with.
8. **Internal consumers** are registered in code (`consumers.ts`) and run by the same worker with the same retry semantics. The first intended consumer is automatic journal drafting, which stays unregistered until posting policy exists.
9. **Housekeeping**: idempotency keys older than 7 days and delivered attempts older than 30 days are purged by the worker.

## Not built / limitations
- No per-endpoint rate limit or circuit breaker; a slow receiver still occupies a delivery slot for up to 10 seconds per attempt.
- No payload filtering or field selection per subscriber, and no event schema registry beyond `schemaVersion: 1`.
- Subscriptions are organization-wide, not scoped to a legal entity or location. A subscriber sees that an event happened anywhere in the organization.
- No automatic disabling of a persistently failing endpoint; operators watch the dead-letter list.
- Retention of events is unbounded; partitioning and archiving are future work.
- The worker has been exercised only against local receivers and the test database, never against a real internet endpoint.
