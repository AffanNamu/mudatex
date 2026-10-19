import type { Tx } from './db.js';

/**
 * Next number for a document kind within a legal entity. Runs in the document's own transaction, so a
 * rollback gives the number back and committed numbers have no gaps.
 */
export async function nextDocumentNumber(tx: Tx, organizationId: string, legalEntityId: string, kind: string, prefix: string): Promise<string> {
  const { rows } = await tx.query<{ n: string }>(
    `INSERT INTO document_sequences (organization_id, legal_entity_id, kind, next_no) VALUES ($1, $2, $3, 2)
     ON CONFLICT (legal_entity_id, kind) DO UPDATE SET next_no = document_sequences.next_no + 1
     RETURNING next_no - 1 AS n`,
    [organizationId, legalEntityId, kind],
  );
  return `${prefix}-${rows[0]!.n.padStart(6, '0')}`;
}
