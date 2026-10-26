import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withTx, type Db, type Tx } from './db.js';
import { AppError, invalid } from './errors.js';

export interface CommandResult {
  status: number;
  body: unknown;
}

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Runs a state-changing command at most once per (user, Idempotency-Key).
 * The key row is inserted in the command's own transaction: a concurrent duplicate
 * blocks on the primary key until the first commits, then replays its stored
 * response. A failed command rolls back with its key, so a retry runs again.
 */
export async function idempotent(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  fn: (tx: Tx) => Promise<CommandResult>,
): Promise<FastifyReply> {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
    throw new AppError(400, 'idempotency_key_required', 'Idempotency-Key header (8-128 characters) is required');
  }
  const { actor } = req;
  const path = req.url.split('?')[0];
  const hash = createHash('sha256')
    .update(stable({ method: req.method, path, body: req.body ?? null }))
    .digest('hex');

  const outcome = await withTx(db, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO idempotency_keys (organization_id, user_id, key, request_hash)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [actor.organizationId, actor.userId, key, hash],
    );
    if (inserted.rowCount) {
      const result = await fn(tx);
      await tx.query(
        `UPDATE idempotency_keys SET status_code = $4, response_body = $5
          WHERE organization_id = $1 AND user_id = $2 AND key = $3`,
        [actor.organizationId, actor.userId, key, result.status, JSON.stringify(result.body ?? null)],
      );
      return { ...result, replayed: false };
    }
    const { rows } = await tx.query<{ request_hash: string; status_code: number; response_body: unknown }>(
      `SELECT request_hash, status_code, response_body FROM idempotency_keys
        WHERE organization_id = $1 AND user_id = $2 AND key = $3`,
      [actor.organizationId, actor.userId, key],
    );
    const stored = rows[0]!;
    if (stored.request_hash !== hash) throw invalid('Idempotency-Key was already used for a different request');
    return { status: stored.status_code, body: stored.response_body, replayed: true };
  });

  if (outcome.replayed) reply.header('Idempotent-Replayed', 'true');
  return outcome.status === 204 ? reply.status(204).send() : reply.status(outcome.status).send(outcome.body);
}
