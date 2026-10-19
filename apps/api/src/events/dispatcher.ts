import type { Db } from '../db.js';
import { withTx } from '../db.js';
import { matchesPattern } from './publish.js';
import type { SecretBox } from './secretbox.js';
import { sign } from './signing.js';
import { assertSafeUrl, type UrlPolicy } from './url-safety.js';

export interface DomainEvent {
  id: string;
  organizationId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  actorUserId: string | null;
  requestId: string | null;
  occurredAt: Date;
}

/** An in-process subscriber (for example automatic journal drafting). It must be idempotent: delivery is at-least-once. */
export interface InternalConsumer {
  name: string;
  /** Event type patterns, same syntax as webhook subscriptions. */
  patterns: string[];
  handle(db: Db, event: DomainEvent): Promise<void>;
}

export interface DispatcherOptions {
  secretBox: SecretBox | null;
  urlPolicy: UrlPolicy;
  consumers?: InternalConsumer[];
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  timeoutMs?: number;
  jitter?: () => number;   // 0..1
  log?: (msg: string, extra?: unknown) => void;
}

const LEASE_SECONDS = 120;

export function backoffSeconds(attempt: number, jitter = Math.random()): number {
  const base = Math.min(30 * 2 ** (attempt - 1), 6 * 3600);
  return Math.round(base * (0.8 + 0.4 * jitter));
}

interface Claimed {
  id: string;
  event_id: string;
  organization_id: string;
  target_kind: 'webhook' | 'internal';
  target_key: string;
  endpoint_id: string | null;
  attempts: number;
}

export class Dispatcher {
  private readonly consumers: InternalConsumer[];
  private readonly maxAttempts: number;
  constructor(private readonly db: Db, private readonly opts: DispatcherOptions) {
    this.consumers = opts.consumers ?? [];
    this.maxAttempts = opts.maxAttempts ?? 10;
  }

  /** Creates a delivery for every matching webhook and internal consumer. Safe to run from several workers at once. */
  async fanOut(batch = 100, now = new Date()): Promise<number> {
    return withTx(this.db, async (tx) => {
      const { rows } = await tx.query<{ id: string; organization_id: string; event_type: string }>(
        `SELECT id, organization_id, event_type FROM domain_events WHERE fanned_out_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [batch],
      );
      for (const ev of rows) {
        const eps = await tx.query<{ id: string; event_types: string[] }>(
          `SELECT id, event_types FROM webhook_endpoints WHERE organization_id = $1 AND status = 'active'`,
          [ev.organization_id],
        );
        for (const ep of eps.rows) {
          if (!ep.event_types.some((p) => matchesPattern(p, ev.event_type))) continue;
          await tx.query(
            `INSERT INTO event_deliveries (event_id, organization_id, target_kind, target_key, endpoint_id, next_attempt_at)
             VALUES ($1, $2, 'webhook', $3::text, $3::uuid, $4) ON CONFLICT DO NOTHING`,
            [ev.id, ev.organization_id, ep.id, now],
          );
        }
        for (const c of this.consumers) {
          if (!c.patterns.some((p) => matchesPattern(p, ev.event_type))) continue;
          await tx.query(
            `INSERT INTO event_deliveries (event_id, organization_id, target_kind, target_key, next_attempt_at)
             VALUES ($1, $2, 'internal', $3, $4) ON CONFLICT DO NOTHING`,
            [ev.id, ev.organization_id, c.name, now],
          );
        }
        await tx.query('UPDATE domain_events SET fanned_out_at = now() WHERE id = $1', [ev.id]);
      }
      return rows.length;
    });
  }

  /**
   * Claims due deliveries with a lease (so a crashed worker's claims expire and are retried) and attempts them
   * outside any database transaction.
   */
  async deliverDue(now = new Date(), batch = 25): Promise<number> {
    const { rows } = await this.db.query<Claimed>(
      `UPDATE event_deliveries SET status = 'sending', attempts = attempts + 1, locked_until = $1::timestamptz + make_interval(secs => $3)
        WHERE id IN (
          SELECT id FROM event_deliveries
           WHERE status IN ('pending', 'sending') AND next_attempt_at <= $1 AND (locked_until IS NULL OR locked_until <= $1)
           ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING id, event_id, organization_id, target_kind, target_key, endpoint_id, attempts`,
      [now, batch, LEASE_SECONDS],
    );
    for (const d of rows) {
      try {
        await this.attempt(d, now);
      } catch (err) {
        await this.settle(d, now, { ok: false, retry: true, error: `internal error: ${(err as Error).message}`.slice(0, 500) });
      }
    }
    return rows.length;
  }

  /** One pass of the worker loop. Returns how much work it found. */
  async runOnce(now = new Date()): Promise<number> {
    const fanned = await this.fanOut(100, now);
    const delivered = await this.deliverDue(now);
    return fanned + delivered;
  }

  private async loadEvent(id: string): Promise<DomainEvent> {
    const { rows } = await this.db.query(
      `SELECT id, organization_id AS "organizationId", event_type AS type, aggregate_type AS "aggregateType", aggregate_id AS "aggregateId",
              payload, actor_user_id AS "actorUserId", request_id AS "requestId", occurred_at AS "occurredAt" FROM domain_events WHERE id = $1`,
      [id],
    );
    return { ...rows[0], id: String(rows[0].id) };
  }

  private async attempt(d: Claimed, now: Date): Promise<void> {
    const event = await this.loadEvent(d.event_id);
    if (d.target_kind === 'internal') {
      const c = this.consumers.find((x) => x.name === d.target_key);
      if (!c) return this.settle(d, now, { ok: false, retry: false, error: `no consumer named ${d.target_key}` });
      await c.handle(this.db, event);
      return this.settle(d, now, { ok: true });
    }

    const ep = await this.db.query<{ url: string; status: string; secret_encrypted: string }>('SELECT url, status, secret_encrypted FROM webhook_endpoints WHERE id = $1', [d.endpoint_id]);
    const endpoint = ep.rows[0];
    if (!endpoint || endpoint.status === 'disabled') return this.settle(d, now, { ok: false, retry: false, error: 'endpoint disabled' });
    if (endpoint.status === 'paused') {
      // Hold the delivery without spending an attempt.
      await this.db.query(`UPDATE event_deliveries SET status = 'pending', attempts = attempts - 1, locked_until = NULL, next_attempt_at = $2::timestamptz + interval '5 minutes' WHERE id = $1`, [d.id, now]);
      return;
    }
    if (!this.opts.secretBox) return this.settle(d, now, { ok: false, retry: true, error: 'SECRETS_ENCRYPTION_KEY is not configured' });

    const url = await assertSafeUrl(endpoint.url, this.opts.urlPolicy);   // re-checked every time: DNS can change
    const body = JSON.stringify({
      id: event.id, type: event.type, schemaVersion: 1, occurredAt: event.occurredAt.toISOString(), organizationId: event.organizationId,
      aggregateType: event.aggregateType, aggregateId: event.aggregateId, actorUserId: event.actorUserId, requestId: event.requestId, payload: event.payload,
    });
    const secret = this.opts.secretBox.decrypt(endpoint.secret_encrypted);
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mudatex-Webhooks/1',
        'mudatex-event-id': event.id,
        'mudatex-event-type': event.type,
        'mudatex-signature': sign(secret, body),
      },
      body,
    }).catch((err: Error) => ({ networkError: err.name === 'TimeoutError' ? 'timeout' : err.message }));

    if ('networkError' in res) return this.settle(d, now, { ok: false, retry: true, error: `network: ${res.networkError}`.slice(0, 500) });
    void res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) return this.settle(d, now, { ok: true, statusCode: res.status });
    // Rate limits, timeouts and server errors are worth retrying. Other 4xx (and redirects) mean the receiver rejected it.
    const retry = res.status === 408 || res.status === 429 || res.status >= 500;
    return this.settle(d, now, { ok: false, retry, statusCode: res.status, error: `HTTP ${res.status}` });
  }

  private async settle(d: Claimed, now: Date, r: { ok: boolean; retry?: boolean; statusCode?: number; error?: string }): Promise<void> {
    if (r.ok) {
      await this.db.query(
        `UPDATE event_deliveries SET status = 'delivered', delivered_at = $2, locked_until = NULL, last_status_code = $3, last_error = NULL WHERE id = $1`,
        [d.id, now, r.statusCode ?? null],
      );
      return;
    }
    const dead = !r.retry || d.attempts >= this.maxAttempts;
    const delay = backoffSeconds(d.attempts, this.opts.jitter?.());
    await this.db.query(
      `UPDATE event_deliveries SET status = $2, locked_until = NULL, last_status_code = $3, last_error = $4,
              next_attempt_at = $5::timestamptz + make_interval(secs => $6) WHERE id = $1`,
      [d.id, dead ? 'dead' : 'pending', r.statusCode ?? null, r.error ?? null, now, dead ? 0 : delay],
    );
    if (dead) this.opts.log?.('delivery moved to dead letter', { delivery: d.id, target: d.target_key, error: r.error });
  }
}
