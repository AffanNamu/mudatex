import type { Tx } from '../db.js';

export interface EventInput {
  organizationId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload?: Record<string, unknown>;
  actorUserId?: string | null;
  requestId?: string;
}

/**
 * Records a domain event inside the caller's transaction, so an event exists if and only if the change
 * that caused it committed. Events are thin on purpose: a reference to the thing that changed, never its
 * contents, so consumers read current state through the API and cannot be handed sensitive fields.
 */
export async function publishEvent(tx: Tx, e: EventInput): Promise<void> {
  await tx.query(
    `INSERT INTO domain_events (organization_id, event_type, aggregate_type, aggregate_id, payload, actor_user_id, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.organizationId, e.type, e.aggregateType, e.aggregateId, JSON.stringify(e.payload ?? {}), e.actorUserId ?? null, e.requestId ?? null],
  );
}

/** `*` matches everything; `a.b.*` matches anything under `a.b.`; otherwise an exact match. */
export function matchesPattern(pattern: string, type: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

export const EVENT_PATTERN = /^(\*|[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(\.\*)?)$/;
