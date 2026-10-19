import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { POS_ROLES, processSource } from '../accounting/pos-posting.js';
import { authorize } from '../auth/authorize.js';
import { withTx, type Db } from '../db.js';
import { invalid, notFound } from '../errors.js';
import { audit, uuid } from '../inventory/common.js';

const rulesBody = z.object({
  enabled: z.boolean(),
  accounts: z.record(z.enum(POS_ROLES), uuid).default({}),
});

export const postingRuleRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  // Rules are off until a legal entity turns them on, and they only ever draft journals for review.
  app.put('/accounting/posting-rules/:legalEntityId/pos', async (req) => {
    const { legalEntityId } = z.object({ legalEntityId: uuid }).parse(req.params);
    const body = rulesBody.parse(req.body);
    const { actor } = req;
    return withTx(db, async (tx) => {
      await authorize(tx, actor, 'accounting.manage', { kind: 'legal_entity', legalEntityId });
      const ids = [...new Set(Object.values(body.accounts))];
      if (ids.length) {
        const ok = await tx.query(`SELECT 1 FROM accounts WHERE legal_entity_id = $1 AND id = ANY($2::uuid[]) AND is_postable AND status = 'active'`, [legalEntityId, ids]);
        if (ok.rowCount !== ids.length) throw invalid('Every mapped account must be an active, postable account of this legal entity');
      }
      if (body.enabled && !body.accounts.salesRevenue) throw invalid('Map a sales revenue account before enabling');
      if (body.enabled && !POS_ROLES.some((r) => r !== 'salesRevenue' && r !== 'salesTaxPayable' && body.accounts[r])) throw invalid('Map at least one payment method clearing account before enabling');
      await tx.query(
        `INSERT INTO posting_rule_sets (legal_entity_id, kind, organization_id, enabled, accounts, updated_by, updated_at) VALUES ($1, 'pos_revenue', $2, $3, $4, $5, now())
         ON CONFLICT (legal_entity_id, kind) DO UPDATE SET enabled = EXCLUDED.enabled, accounts = EXCLUDED.accounts, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [legalEntityId, actor.organizationId, body.enabled, JSON.stringify(body.accounts), actor.userId],
      );
      await audit(tx, req, 'posting_rules.update', 'legal_entity', legalEntityId, body);
      return { legalEntityId, kind: 'pos_revenue', ...body };
    });
  });

  app.get('/accounting/posting-rules/:legalEntityId/pos', async (req) => {
    const { legalEntityId } = z.object({ legalEntityId: uuid }).parse(req.params);
    await authorize(db, req.actor, 'accounting.read', { kind: 'legal_entity', legalEntityId });
    const r = await db.query('SELECT enabled, accounts FROM posting_rule_sets WHERE legal_entity_id = $1 AND organization_id = $2 AND kind = \'pos_revenue\'', [legalEntityId, req.actor.organizationId]);
    return { legalEntityId, kind: 'pos_revenue', enabled: r.rows[0]?.enabled ?? false, accounts: r.rows[0]?.accounts ?? {} };
  });

  app.get('/accounting/posting-log', async (req) => {
    const q = z.object({ legalEntityId: uuid, status: z.enum(['drafted', 'skipped']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    await authorize(db, req.actor, 'accounting.read', { kind: 'legal_entity', legalEntityId: q.legalEntityId });
    const { rows } = await db.query(
      `SELECT source_type AS "sourceType", source_id AS "sourceId", status, reason, journal_id AS "journalId", updated_at AS "updatedAt"
         FROM posting_log WHERE legal_entity_id = $1 AND organization_id = $2 AND ($3::text IS NULL OR status = $3) ORDER BY updated_at DESC, source_id LIMIT $4`,
      [q.legalEntityId, req.actor.organizationId, q.status ?? null, q.limit],
    );
    return rows;
  });

  // After fixing the configuration, re-run a skipped document.
  app.post('/accounting/posting-log/:sourceType/:sourceId/retry', async (req) => {
    const { sourceType, sourceId } = z.object({ sourceType: z.enum(['pos_sale', 'pos_return']), sourceId: uuid }).parse(req.params);
    const { actor } = req;
    const owner = await db.query<{ legal_entity_id: string }>('SELECT legal_entity_id FROM posting_log WHERE source_type = $1 AND source_id = $2 AND organization_id = $3', [sourceType, sourceId, actor.organizationId]);
    if (!owner.rows[0]) throw notFound('Posting log entry');
    await authorize(db, actor, 'accounting.journal', { kind: 'legal_entity', legalEntityId: owner.rows[0].legal_entity_id });
    return processSource(db, sourceType, sourceId);
  });

  // Drafts journals for sales and returns that happened before the rules were enabled. Safe to repeat.
  app.post('/accounting/posting-rules/:legalEntityId/backfill', async (req) => {
    const { legalEntityId } = z.object({ legalEntityId: uuid }).parse(req.params);
    const body = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), limit: z.number().int().min(1).max(1000).default(500) }).parse(req.body);
    const { actor } = req;
    await authorize(db, actor, 'accounting.manage', { kind: 'legal_entity', legalEntityId });
    const sales = await db.query<{ id: string }>(
      `SELECT s.id FROM pos_sales s JOIN locations l ON l.id = s.location_id
        WHERE s.legal_entity_id = $1 AND s.organization_id = $2 AND s.status = 'completed'
          AND (COALESCE(s.completed_at, s.created_at) AT TIME ZONE l.timezone)::date BETWEEN $3::date AND $4::date
          AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.legal_entity_id = s.legal_entity_id AND j.source_type = 'pos_sale' AND j.source_id = s.id::text)
        ORDER BY s.created_at LIMIT $5`,
      [legalEntityId, actor.organizationId, body.from, body.to, body.limit],
    );
    const returns = await db.query<{ id: string }>(
      `SELECT r.id FROM pos_returns r JOIN pos_sales s ON s.id = r.sale_id JOIN locations l ON l.id = s.location_id
        WHERE s.legal_entity_id = $1 AND s.organization_id = $2 AND (r.created_at AT TIME ZONE l.timezone)::date BETWEEN $3::date AND $4::date
          AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.legal_entity_id = s.legal_entity_id AND j.source_type = 'pos_return' AND j.source_id = r.id::text)
        ORDER BY r.created_at LIMIT $5`,
      [legalEntityId, actor.organizationId, body.from, body.to, body.limit],
    );
    const counts = { drafted: 0, skipped: 0, disabled: 0, other: 0 };
    for (const [type, rows] of [['pos_sale', sales.rows], ['pos_return', returns.rows]] as const) {
      for (const r of rows) {
        const o = await processSource(db, type, r.id);
        if (o.status === 'drafted') counts.drafted++;
        else if (o.status === 'skipped') counts.skipped++;
        else if (o.status === 'disabled') counts.disabled++;
        else counts.other++;
      }
    }
    return { considered: sales.rows.length + returns.rows.length, ...counts };
  });
};
