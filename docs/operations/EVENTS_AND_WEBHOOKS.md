# Events and webhooks

Every audited action in Mudatex also produces a **domain event**, written in the same database transaction as the change. If the change rolls back, so does the event. Events are *thin*: they say what happened and to which record, never what the record contains. A consumer reads current state through the API.

## Delivery guarantees

- **At least once.** A delivery can be repeated (a timeout after the receiver processed it, a worker restart). Treat the event `id` as an idempotency key and ignore ids you have already handled.
- **No ordering guarantee.** A retried event can arrive after a later one. Use the API to read current state rather than replaying events in sequence.
- **Retries** use exponential backoff from 30 seconds, capped at 6 hours, up to 10 attempts. A response of `408`, `429` or any `5xx`, a timeout, or a connection error is retried. Any other response (including redirects, which are never followed) is a permanent rejection and goes straight to the dead-letter list.
- **Dead letters** stay visible at `GET /v1/integrations/deliveries?status=dead` and can be re-queued with `POST /v1/integrations/deliveries/:id/retry` once the receiver is fixed.
- Delivered attempts are purged after 30 days. Events themselves are kept.

## Subscribing

```
POST /v1/integrations/webhooks
{ "url": "https://example.com/hooks/mudatex", "eventTypes": ["pos.*", "journal.post"] }
```

Patterns: `*` (everything), `pos.*` (anything under `pos.`), or an exact type. The response includes `secret` **once**; store it. Lose it and you must `POST .../rotate-secret`. Other endpoints: `pause`, `resume`, `disable`, `test` (sends a `webhook.test` event to that endpoint only), `GET /v1/integrations/events` (the event feed, with an `afterId` cursor).

Targets must be `https://` and must not resolve to private, loopback or link-local addresses (this protects Mudatex's own network). The address is checked again on every delivery.

## What you receive

`POST` with `Content-Type: application/json` and these headers:

| Header | Value |
|---|---|
| `Mudatex-Event-Id` | the event id, your idempotency key |
| `Mudatex-Event-Type` | e.g. `pos.sale` |
| `Mudatex-Signature` | `t=<unix seconds>,v1=<hex>` |

```json
{
  "id": "1042", "type": "pos.sale", "schemaVersion": 1,
  "occurredAt": "2026-10-19T10:15:00.000Z", "organizationId": "…",
  "aggregateType": "pos_sale", "aggregateId": "…",
  "actorUserId": "…", "requestId": "…", "payload": {}
}
```

## Verify every request

The signature is an HMAC-SHA256, keyed with your webhook secret, of the string `"<t>.<raw request body>"`. Verify against the **raw bytes** you received, compare in constant time, and reject timestamps more than five minutes old.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret, rawBody, header, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Respond with any `2xx` quickly (within 10 seconds) and do the real work afterwards.

## Event types

Event types are the audit action names. Commonly useful ones:

| Area | Types |
|---|---|
| Point of sale | `pos.sale`, `pos.sale_cancel`, `pos.payment_verify`, `pos.payment_fail`, `pos.return`, `pos.refund_disburse`, `pos.session_open`, `pos.session_close` |
| Inventory | `inventory.receipt`, `inventory.issue`, `inventory.roll_split`, `inventory.reserve`, `inventory.reservation_fulfil`, `inventory.reservation_release`, `inventory.transfer_dispatch`, `inventory.transfer_receive`, `inventory.transfer_cancel`, `inventory.adjustment_request`, `inventory.adjustment_approve`, `inventory.adjustment_reject` |
| Procurement | `po.create`, `po.submit`, `po.approve`, `po.reject`, `po.cancel`, `po.close`, `po.receive`, `po.return`, `supplier.create` |
| Accounting | `journal.create`, `journal.post`, `journal.reverse`, `period.close`, `period.reopen`, `rate.create`, `rate.approved` |
| Manufacturing | `bom.create`, `bom.approve`, `wo.create`, `wo.release`, `wo.issue`, `wo.return`, `wo.output`, `wo.complete`, `wo.close`, `wo.cancel` |
| Quality | `quality.hold`, `quality.release` |
| Administration | `membership.grant`, `membership.revoke`, `user.create`, `user.suspend`, `role.create` |

The full set is whatever `audit(...)` is called with; `GET /v1/integrations/events` lists what has actually occurred.

## Running the worker

Deliveries are made by a worker, not by the API request. Either run `node dist/worker.js` as its own process (recommended, and you can run several), or set `RUN_WORKER_IN_API=true` to run it inside the API process. It needs `SECRETS_ENCRYPTION_KEY` (the same 32-byte base64 key the API uses) to decrypt webhook secrets. Generate one with `openssl rand -base64 32` and keep it in your secret store. Losing it makes stored webhook secrets unreadable; rotate them if that happens.
