import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, authorizeAnywhere } from '../auth/authorize.js';
import { withTx, type Db } from '../db.js';
import { normalize } from '../domain/decimal.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { audit, uuid } from '../inventory/common.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const accountBody = z.object({
  legalEntityId: uuid,
  code: z.string().regex(/^[0-9A-Za-z.-]{1,20}$/),
  name: z.string().min(1).max(200),
  type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
  parentId: uuid.optional(),
  isPostable: z.boolean().default(true),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
});

const periodBody = z.object({ legalEntityId: uuid, name: z.string().min(1).max(60), startDate: date, endDate: date });
const rateBody = z.object({
  fromCurrency: z.string().regex(/^[A-Z]{3}$/),
  toCurrency: z.string().regex(/^[A-Z]{3}$/),
  rate: z.string().regex(/^\d+(\.\d{1,10})?$/),
  effectiveDate: date,
  source: z.string().trim().min(2).max(200),
});

const ACCOUNT_COLS = `id, legal_entity_id AS "legalEntityId", code, name, type, parent_id AS "parentId", is_postable AS "isPostable", currency, status`;

export const accountingConfigRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/accounting/accounts', async (req, reply) => {
    const body = accountBody.parse(req.body);
    const { actor } = req;
    if (!body.isPostable && body.currency) throw invalid('Header accounts cannot be restricted to a currency');
    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'accounting.manage', { kind: 'legal_entity', legalEntityId: body.legalEntityId });
      if (body.parentId) {
        const p = await tx.query<{ is_postable: boolean; type: string }>('SELECT is_postable, type FROM accounts WHERE id = $1 AND legal_entity_id = $2', [body.parentId, body.legalEntityId]);
        if (!p.rows[0]) throw notFound('Parent account');
        if (p.rows[0].is_postable) throw invalid('A parent must be a header (non-postable) account');
        if (p.rows[0].type !== body.type) throw invalid('A child account must have the same type as its parent');
      }
      const { rows } = await tx.query(
        `INSERT INTO accounts (organization_id, legal_entity_id, code, name, type, parent_id, is_postable, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${ACCOUNT_COLS}`,
        [actor.organizationId, body.legalEntityId, body.code, body.name, body.type, body.parentId ?? null, body.isPostable, body.currency ?? null],
      );
      await audit(tx, req, 'account.create', 'account', rows[0].id, rows[0]);
      return rows[0];
    });
    return reply.status(201).send(created);
  });

  app.get('/accounting/accounts', async (req) => {
    const q = z.object({ legalEntityId: uuid }).parse(req.query);
    await authorize(db, req.actor, 'accounting.read', { kind: 'legal_entity', legalEntityId: q.legalEntityId });
    const { rows } = await db.query(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE legal_entity_id = $1 AND organization_id = $2 ORDER BY code`, [q.legalEntityId, req.actor.organizationId]);
    return rows;
  });

  // Archived accounts keep their history but accept no new postings.
  app.post('/accounting/accounts/:id/archive', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return withTx(db, async (tx) => {
      const a = await tx.query<{ legal_entity_id: string }>('SELECT legal_entity_id FROM accounts WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, actor.organizationId]);
      if (!a.rows[0]) throw notFound('Account');
      await authorize(tx, actor, 'accounting.manage', { kind: 'legal_entity', legalEntityId: a.rows[0].legal_entity_id });
      const { rows } = await tx.query(`UPDATE accounts SET status = 'archived' WHERE id = $1 RETURNING ${ACCOUNT_COLS}`, [id]);
      await audit(tx, req, 'account.archive', 'account', id);
      return rows[0];
    });
  });

  app.put('/accounting/settings/:legalEntityId', async (req) => {
    const { legalEntityId } = z.object({ legalEntityId: uuid }).parse(req.params);
    const body = z.object({ fxRoundingAccountId: uuid.nullable() }).parse(req.body);
    const { actor } = req;
    return withTx(db, async (tx) => {
      await authorize(tx, actor, 'accounting.manage', { kind: 'legal_entity', legalEntityId });
      if (body.fxRoundingAccountId) {
        const a = await tx.query('SELECT 1 FROM accounts WHERE id = $1 AND legal_entity_id = $2 AND is_postable AND status = \'active\'', [body.fxRoundingAccountId, legalEntityId]);
        if (!a.rowCount) throw invalid('Rounding account must be an active, postable account of this legal entity');
      }
      await tx.query(
        `INSERT INTO accounting_settings (legal_entity_id, organization_id, fx_rounding_account_id) VALUES ($1, $2, $3)
         ON CONFLICT (legal_entity_id) DO UPDATE SET fx_rounding_account_id = EXCLUDED.fx_rounding_account_id`,
        [legalEntityId, actor.organizationId, body.fxRoundingAccountId],
      );
      await audit(tx, req, 'accounting.settings', 'legal_entity', legalEntityId, body);
      return { legalEntityId, fxRoundingAccountId: body.fxRoundingAccountId };
    });
  });

  const PERIOD_COLS = `id, legal_entity_id AS "legalEntityId", name, start_date::text AS "startDate", end_date::text AS "endDate", status, reopen_reason AS "reopenReason"`;

  app.post('/accounting/periods', async (req, reply) => {
    const body = periodBody.parse(req.body);
    const { actor } = req;
    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'accounting.manage', { kind: 'legal_entity', legalEntityId: body.legalEntityId });
      if (body.endDate < body.startDate) throw invalid('Period ends before it starts');
      try {
        const { rows } = await tx.query(
          `INSERT INTO fiscal_periods (organization_id, legal_entity_id, name, start_date, end_date) VALUES ($1,$2,$3,$4,$5) RETURNING ${PERIOD_COLS}`,
          [actor.organizationId, body.legalEntityId, body.name, body.startDate, body.endDate],
        );
        await audit(tx, req, 'period.create', 'fiscal_period', rows[0].id, rows[0]);
        return rows[0];
      } catch (err) {
        if ((err as { code?: string }).code === '23P01') throw conflict('Period overlaps an existing period');
        throw err;
      }
    });
    return reply.status(201).send(created);
  });

  app.get('/accounting/periods', async (req) => {
    const q = z.object({ legalEntityId: uuid }).parse(req.query);
    await authorize(db, req.actor, 'accounting.read', { kind: 'legal_entity', legalEntityId: q.legalEntityId });
    const { rows } = await db.query(`SELECT ${PERIOD_COLS} FROM fiscal_periods WHERE legal_entity_id = $1 AND organization_id = $2 ORDER BY start_date`, [q.legalEntityId, req.actor.organizationId]);
    return rows;
  });

  app.post('/accounting/periods/:id/close', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      // FOR UPDATE waits for in-flight postings (which hold FOR SHARE) and blocks new ones until commit.
      const p = await tx.query<{ legal_entity_id: string; status: string; start_date: string; end_date: string }>(
        'SELECT legal_entity_id, status, start_date::text, end_date::text FROM fiscal_periods WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [id, actor.organizationId],
      );
      const row = p.rows[0];
      if (!row) throw notFound('Period');
      await authorize(tx, actor, 'accounting.period.close', { kind: 'legal_entity', legalEntityId: row.legal_entity_id });
      if (row.status !== 'open') throw conflict('Period is already closed');
      const drafts = await tx.query(
        `SELECT 1 FROM journal_entries WHERE legal_entity_id = $1 AND status = 'draft' AND posting_date BETWEEN $2 AND $3 LIMIT 1`,
        [row.legal_entity_id, row.start_date, row.end_date],
      );
      if (drafts.rowCount) throw conflict('Post or delete the draft journals dated in this period before closing it');
      const { rows } = await tx.query(`UPDATE fiscal_periods SET status = 'closed', closed_by = $2, closed_at = now() WHERE id = $1 RETURNING ${PERIOD_COLS}`, [id, actor.userId]);
      await audit(tx, req, 'period.close', 'fiscal_period', id);
      return { status: 200, body: rows[0] };
    });
  });

  app.post('/accounting/periods/:id/reopen', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const p = await tx.query<{ legal_entity_id: string; status: string; closed_by: string | null }>('SELECT legal_entity_id, status, closed_by FROM fiscal_periods WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, actor.organizationId]);
      const row = p.rows[0];
      if (!row) throw notFound('Period');
      await authorize(tx, actor, 'accounting.period.reopen', { kind: 'legal_entity', legalEntityId: row.legal_entity_id });
      if (row.status !== 'closed') throw conflict('Period is not closed');
      if (row.closed_by === actor.userId) throw forbidden('A different person must reopen a period you closed');
      const { rows } = await tx.query(
        `UPDATE fiscal_periods SET status = 'open', reopened_by = $2, reopened_at = now(), reopen_reason = $3 WHERE id = $1 RETURNING ${PERIOD_COLS}`,
        [id, actor.userId, body.reason],
      );
      await audit(tx, req, 'period.reopen', 'fiscal_period', id, { reason: body.reason });
      return { status: 200, body: rows[0] };
    });
  });

  const RATE_COLS = `id, from_currency AS "fromCurrency", to_currency AS "toCurrency", rate, effective_date::text AS "effectiveDate", source, status, created_by AS "createdBy", decided_by AS "decidedBy"`;
  const rateView = (r: { rate: string }) => ({ ...r, rate: normalize(r.rate, 10) });

  app.post('/accounting/exchange-rates', async (req, reply) => {
    const body = rateBody.parse(req.body);
    const { actor } = req;
    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'accounting.rates.manage', { kind: 'organization' });
      const { rows } = await tx.query(
        `INSERT INTO exchange_rates (organization_id, from_currency, to_currency, rate, effective_date, source, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${RATE_COLS}`,
        [actor.organizationId, body.fromCurrency, body.toCurrency, body.rate, body.effectiveDate, body.source, actor.userId],
      );
      await audit(tx, req, 'rate.create', 'exchange_rate', rows[0].id, rows[0]);
      return rateView(rows[0]);
    });
    return reply.status(201).send(created);
  });

  const decide = (decision: 'approved' | 'rejected') => async (req: import('fastify').FastifyRequest) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return withTx(db, async (tx) => {
      await authorize(tx, actor, 'accounting.rates.approve', { kind: 'organization' });
      const r = await tx.query<{ status: string; created_by: string }>('SELECT status, created_by FROM exchange_rates WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, actor.organizationId]);
      if (!r.rows[0]) throw notFound('Exchange rate');
      if (r.rows[0].status !== 'pending') throw conflict(`Rate is already ${r.rows[0].status}`);
      if (r.rows[0].created_by === actor.userId) throw forbidden('You cannot decide a rate you entered');
      const { rows } = await tx.query(`UPDATE exchange_rates SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING ${RATE_COLS}`, [id, decision, actor.userId]);
      await audit(tx, req, `rate.${decision}`, 'exchange_rate', id);
      return rateView(rows[0]);
    });
  };
  app.post('/accounting/exchange-rates/:id/approve', decide('approved'));
  app.post('/accounting/exchange-rates/:id/reject', decide('rejected'));

  app.get('/accounting/exchange-rates', async (req) => {
    await authorizeAnywhere(db, req.actor, 'accounting.read');
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() }).parse(req.query);
    const { rows } = await db.query<{ rate: string }>(
      `SELECT ${RATE_COLS} FROM exchange_rates WHERE organization_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY effective_date DESC, from_currency`,
      [req.actor.organizationId, q.status ?? null],
    );
    return rows.map(rateView);
  });

};
