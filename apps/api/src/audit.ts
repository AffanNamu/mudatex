import type { Tx } from './db.js';

export interface AuditEntry {
  organizationId: string;
  actorUserId: string | null;
  requestId?: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

/** Must be called with the transaction that performs the audited change. */
export async function writeAudit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (organization_id, actor_user_id, request_id, action, entity_type, entity_id, before_state, after_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.organizationId,
      e.actorUserId,
      e.requestId ?? null,
      e.action,
      e.entityType,
      e.entityId,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
    ],
  );
}
