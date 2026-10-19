import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { lockEntry, postEntry, replaceLines, validateDraftLines, type DraftLine } from '../accounting/posting.js';
import { authorize, grantsFor } from '../auth/authorize.js';
import { withTx, type Db, type Tx } from '../db.js';
import { normalize } from '../domain/decimal.js';
import { conflict, invalid, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { audit, uuid } from '../inventory/common.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const lineBody = z.object({
  accountId: uuid,
  debitMinor: minor.default(0),
  creditMinor: minor.default(0),
  description: z.string().max(300).optional(),
  locationId: uuid.optional(),
});

const createBody = z.object({
  legalEntityId: uuid,
  postingDate: date,
  description: z.string().trim().min(3).max(500),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  lines: z.array(lineBody).min(2).max(500),
});

const updateBody = z.object({
  postingDate: date.optional(),
  description: z.string().trim().min(3).max(500).optional(),
  lines: z.array(lineBody).min(2).max(500).optional(),
});

export async function readJournal(db: Db | Tx, organizationId: string, id: string) {
  const e = await db.query(
    `SELECT id, legal_entity_id AS "legalEntityId", journal_number AS "journalNumber", posting_date::text AS "postingDate",
            description, source_type AS "sourceType", source_id AS "sourceId", currency, exchange_rate AS "exchangeRate", status,
            created_by AS "createdBy", posted_by AS "postedBy", posted_at AS "postedAt",
            reverses_entry_id AS "reversesEntryId", reversed_by_entry_id AS "reversedByEntryId"
       FROM journal_entries WHERE id = $1 AND organization_id = $2`,
    [id, organizationId],
  );
  if (!e.rows[0]) throw notFound('Journal');
  const lines = await db.query(
    `SELECT l.line_no AS "lineNo", l.account_id AS "accountId", a.code AS "accountCode", l.debit_minor AS "debitMinor", l.credit_minor AS "creditMinor",
            l.functional_debit_minor AS "functionalDebitMinor", l.functional_credit_minor AS "functionalCreditMinor",
            l.description, l.location_id AS "locationId", l.is_fx_rounding AS "isFxRounding"
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY l.line_no`,
    [id],
  );
  const num = (v: unknown) => (v === null ? null : Number(v));
  return {
    ...e.rows[0],
    exchangeRate: e.rows[0].exchangeRate === null ? null : normalize(e.rows[0].exchangeRate, 10),
    lines: lines.rows.map((l) => ({
      ...l,
      debitMinor: num(l.debitMinor), creditMinor: num(l.creditMinor),
      functionalDebitMinor: num(l.functionalDebitMinor), functionalCreditMinor: num(l.functionalCreditMinor),
    })),
  };
}

const toDraft = (l: z.infer<typeof lineBody>): DraftLine => ({ accountId: l.accountId, debitMinor: l.debitMinor, creditMinor: l.creditMinor, description: l.description, locationId: l.locationId });

export const journalRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/accounting/journals', async (req, reply) => {
    const body = createBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      await authorize(tx, actor, 'accounting.journal', { kind: 'legal_entity', legalEntityId: body.legalEntityId });
      const le = await tx.query<{ functional_currency: string }>('SELECT functional_currency FROM legal_entities WHERE id = $1', [body.legalEntityId]);
      const currency = body.currency ?? le.rows[0]!.functional_currency.trim();
      const known = await tx.query('SELECT 1 FROM currencies WHERE code = $1', [currency]);
      if (!known.rowCount) throw invalid(`Unknown currency ${currency}`);
      const lines = body.lines.map(toDraft);
      await validateDraftLines(tx, actor.organizationId, body.legalEntityId, currency, lines);

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO journal_entries (organization_id, legal_entity_id, posting_date, description, currency, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [actor.organizationId, body.legalEntityId, body.postingDate, body.description, currency, actor.userId],
      );
      await replaceLines(tx, rows[0]!.id, lines);
      await audit(tx, req, 'journal.create', 'journal', rows[0]!.id, { postingDate: body.postingDate, currency });
      return { status: 201, body: await readJournal(tx, actor.organizationId, rows[0]!.id) };
    });
  });

  app.put('/accounting/journals/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = updateBody.parse(req.body);
    const { actor } = req;
    return withTx(db, async (tx) => {
      const e = await lockEntry(tx, actor.organizationId, id);
      await authorize(tx, actor, 'accounting.journal', { kind: 'legal_entity', legalEntityId: e.legal_entity_id });
      if (e.status !== 'draft') throw conflict('Posted journals cannot be edited; reverse them instead');
      if (body.lines) {
        const lines = body.lines.map(toDraft);
        await validateDraftLines(tx, actor.organizationId, e.legal_entity_id, e.currency, lines);
        await replaceLines(tx, id, lines);
      }
      await tx.query('UPDATE journal_entries SET posting_date = COALESCE($2::date, posting_date), description = COALESCE($3, description) WHERE id = $1', [id, body.postingDate ?? null, body.description ?? null]);
      await audit(tx, req, 'journal.update', 'journal', id);
      return readJournal(tx, actor.organizationId, id);
    });
  });

  app.delete('/accounting/journals/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    await withTx(db, async (tx) => {
      const e = await lockEntry(tx, actor.organizationId, id);
      await authorize(tx, actor, 'accounting.journal', { kind: 'legal_entity', legalEntityId: e.legal_entity_id });
      if (e.status !== 'draft') throw conflict('Posted journals cannot be deleted; reverse them instead');
      await tx.query('DELETE FROM journal_lines WHERE entry_id = $1', [id]);
      await tx.query('DELETE FROM journal_entries WHERE id = $1', [id]);
      await audit(tx, req, 'journal.delete', 'journal', id);
    });
    return reply.status(204).send();
  });

  app.post('/accounting/journals/:id/post', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const e = await lockEntry(tx, actor.organizationId, id);
      await authorize(tx, actor, 'accounting.post', { kind: 'legal_entity', legalEntityId: e.legal_entity_id });
      const { journalNumber } = await postEntry(tx, actor.organizationId, actor.userId, id);
      await audit(tx, req, 'journal.post', 'journal', id, { journalNumber });
      return { status: 200, body: await readJournal(tx, actor.organizationId, id) };
    });
  });

  // Creates a draft that mirrors the original with debits and credits swapped, at the original exchange rate.
  // It becomes effective only when someone else posts it.
  app.post('/accounting/journals/:id/reverse', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ postingDate: date, reason: z.string().trim().min(5).max(500) }).parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const e = await lockEntry(tx, actor.organizationId, id);
      await authorize(tx, actor, 'accounting.journal', { kind: 'legal_entity', legalEntityId: e.legal_entity_id });
      if (e.status !== 'posted') throw conflict('Only posted journals can be reversed');
      const orig = await tx.query<{ journal_number: string; posting_date: string; exchange_rate: string; rate_id: string | null; reversed_by_entry_id: string | null }>(
        'SELECT journal_number, posting_date::text, exchange_rate, rate_id, reversed_by_entry_id FROM journal_entries WHERE id = $1',
        [id],
      );
      const o = orig.rows[0]!;
      if (o.reversed_by_entry_id) throw conflict('Journal has already been reversed');
      if (body.postingDate < o.posting_date) throw conflict('A reversal cannot be dated before the original');
      const pending = await tx.query('SELECT 1 FROM journal_entries WHERE reverses_entry_id = $1', [id]);
      if (pending.rowCount) throw conflict('A reversal of this journal is already waiting to be posted');

      const rev = await tx.query<{ id: string }>(
        `INSERT INTO journal_entries (organization_id, legal_entity_id, posting_date, description, source_type, currency, exchange_rate, rate_id, rate_locked, created_by, reverses_entry_id)
         VALUES ($1,$2,$3,$4,'reversal',$5,$6,$7,true,$8,$9) RETURNING id`,
        [actor.organizationId, e.legal_entity_id, body.postingDate, `Reversal of ${o.journal_number}: ${body.reason}`, e.currency, o.exchange_rate, o.rate_id, actor.userId, id],
      );
      const lines = await tx.query<{ account_id: string; debit_minor: string; credit_minor: string; description: string | null; location_id: string | null }>(
        'SELECT account_id, debit_minor, credit_minor, description, location_id FROM journal_lines WHERE entry_id = $1 AND NOT is_fx_rounding ORDER BY line_no',
        [id],
      );
      await replaceLines(tx, rev.rows[0]!.id, lines.rows.map((l) => ({
        accountId: l.account_id, debitMinor: Number(l.credit_minor), creditMinor: Number(l.debit_minor), description: l.description ?? undefined, locationId: l.location_id ?? undefined,
      })));
      await audit(tx, req, 'journal.reverse', 'journal', id, { reversalId: rev.rows[0]!.id, reason: body.reason });
      return { status: 201, body: await readJournal(tx, actor.organizationId, rev.rows[0]!.id) };
    });
  });

  app.get('/accounting/journals/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const j = await readJournal(db, req.actor.organizationId, id);
    await authorize(db, req.actor, 'accounting.read', { kind: 'legal_entity', legalEntityId: j.legalEntityId });
    return j;
  });

  app.get('/accounting/journals', async (req) => {
    const q = z.object({ legalEntityId: uuid.optional(), status: z.enum(['draft', 'posted']).optional(), from: date.optional(), to: date.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const grants = await grantsFor(db, req.actor, 'accounting.read');
    const { rows } = await db.query<{ legalEntityId: string; countryCode: string }>(
      `SELECT j.id, j.legal_entity_id AS "legalEntityId", e.country_code AS "countryCode", j.journal_number AS "journalNumber",
              j.posting_date::text AS "postingDate", j.description, j.status, j.currency
         FROM journal_entries j JOIN legal_entities e ON e.id = j.legal_entity_id
        WHERE j.organization_id = $1 AND ($2::uuid IS NULL OR j.legal_entity_id = $2) AND ($3::text IS NULL OR j.status = $3)
          AND ($4::date IS NULL OR j.posting_date >= $4) AND ($5::date IS NULL OR j.posting_date <= $5)
        ORDER BY j.posting_date DESC, j.journal_number DESC NULLS FIRST, j.id LIMIT $6`,
      [req.actor.organizationId, q.legalEntityId ?? null, q.status ?? null, q.from ?? null, q.to ?? null, q.limit],
    );
    return rows
      .filter((r) => grants.group || grants.countries.has(r.countryCode.trim()) || grants.legalEntities.has(r.legalEntityId))
      .map(({ countryCode: _c, ...r }) => r);
  });
};
