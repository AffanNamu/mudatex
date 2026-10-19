import type { Tx } from '../db.js';
import { nextDocumentNumber } from '../documents.js';
import { convertMinor } from '../domain/money.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';

export interface DraftLine {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  description?: string;
  locationId?: string;
}

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Checks everything that can be known without a rate or period: shape, balance in the
 * transaction currency, and that every account belongs to the entity and may take this posting.
 */
export async function validateDraftLines(tx: Tx, organizationId: string, legalEntityId: string, currency: string, lines: DraftLine[]): Promise<void> {
  if (lines.length < 2) throw invalid('A journal needs at least two lines');
  let debit = 0n;
  let credit = 0n;
  for (const l of lines) {
    const d = BigInt(l.debitMinor);
    const c = BigInt(l.creditMinor);
    if (d < 0n || c < 0n || d > MAX || c > MAX || (d > 0n) === (c > 0n)) {
      throw invalid('Each line must have exactly one of debit or credit, as a positive whole number of minor units');
    }
    debit += d;
    credit += c;
  }
  if (debit !== credit) throw invalid(`Journal does not balance: debits ${debit}, credits ${credit}`);

  const ids = [...new Set(lines.map((l) => l.accountId))];
  const { rows } = await tx.query<{ id: string; legal_entity_id: string; is_postable: boolean; status: string; currency: string | null; code: string }>(
    'SELECT id, legal_entity_id, is_postable, status, currency, code FROM accounts WHERE organization_id = $1 AND id = ANY($2::uuid[])',
    [organizationId, ids],
  );
  if (rows.length !== ids.length) throw notFound('Account');
  for (const a of rows) {
    if (a.legal_entity_id !== legalEntityId) throw invalid(`Account ${a.code} belongs to another legal entity`);
    if (!a.is_postable) throw invalid(`Account ${a.code} is a header account and cannot be posted to`);
    if (a.status !== 'active') throw invalid(`Account ${a.code} is archived`);
    if (a.currency && a.currency.trim() !== currency) throw invalid(`Account ${a.code} only accepts ${a.currency.trim()}`);
  }
  const locs = [...new Set(lines.map((l) => l.locationId).filter((x): x is string => !!x))];
  if (locs.length) {
    const ok = await tx.query('SELECT 1 FROM locations WHERE legal_entity_id = $1 AND id = ANY($2::uuid[])', [legalEntityId, locs]);
    if (ok.rowCount !== locs.length) throw invalid('Location does not belong to this legal entity');
  }
}

export async function replaceLines(tx: Tx, entryId: string, lines: DraftLine[]): Promise<void> {
  await tx.query('DELETE FROM journal_lines WHERE entry_id = $1', [entryId]);
  for (const [i, l] of lines.entries()) {
    await tx.query(
      'INSERT INTO journal_lines (entry_id, line_no, account_id, debit_minor, credit_minor, description, location_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [entryId, i + 1, l.accountId, l.debitMinor, l.creditMinor, l.description ?? null, l.locationId ?? null],
    );
  }
}

interface EntryRow {
  id: string;
  legal_entity_id: string;
  posting_date: string;
  currency: string;
  status: string;
  created_by: string;
  rate_locked: boolean;
  exchange_rate: string | null;
  rate_id: string | null;
  reverses_entry_id: string | null;
}

export async function lockEntry(tx: Tx, organizationId: string, id: string): Promise<EntryRow> {
  const { rows } = await tx.query<EntryRow>(
    `SELECT id, legal_entity_id, posting_date::text AS posting_date, currency, status, created_by, rate_locked, exchange_rate, rate_id, reverses_entry_id
       FROM journal_entries WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [id, organizationId],
  );
  if (!rows[0]) throw notFound('Journal');
  return rows[0];
}

/**
 * Posts a draft journal: finds the open fiscal period (locked against a concurrent close), fixes the exchange
 * rate, computes functional amounts, balances any rounding into the configured account, assigns the next
 * gap-free number and makes the entry permanent. The caller has already authorized the actor.
 */
export async function postEntry(tx: Tx, organizationId: string, actorUserId: string, entryId: string): Promise<{ journalNumber: string }> {
  const entry = await lockEntry(tx, organizationId, entryId);
  if (entry.status !== 'draft') throw conflict('Journal is already posted');
  if (entry.created_by === actorUserId) throw forbidden('You cannot post a journal you created');

  const lines = (await tx.query<{ id: string; account_id: string; debit_minor: string; credit_minor: string; line_no: number; location_id: string | null; description: string | null }>(
    'SELECT id, account_id, debit_minor, credit_minor, line_no, location_id, description FROM journal_lines WHERE entry_id = $1 ORDER BY line_no',
    [entryId],
  )).rows;
  await validateDraftLines(tx, organizationId, entry.legal_entity_id, entry.currency, lines.map((l) => ({
    accountId: l.account_id, debitMinor: Number(l.debit_minor), creditMinor: Number(l.credit_minor), locationId: l.location_id ?? undefined,
  })));

  const period = await tx.query<{ id: string; name: string; status: string }>(
    `SELECT id, name, status FROM fiscal_periods
      WHERE legal_entity_id = $1 AND daterange(start_date, end_date, '[]') @> $2::date FOR SHARE`,
    [entry.legal_entity_id, entry.posting_date],
  );
  const p = period.rows[0];
  if (!p) throw conflict(`No fiscal period covers ${entry.posting_date}`);
  if (p.status !== 'open') throw conflict(`Fiscal period ${p.name} is closed`);

  const cur = await tx.query<{ minor_unit: number }>('SELECT minor_unit FROM currencies WHERE code = $1', [entry.currency]);
  const fn = await tx.query<{ functional_currency: string; minor_unit: number }>(
    'SELECT e.functional_currency, c.minor_unit FROM legal_entities e JOIN currencies c ON c.code = e.functional_currency WHERE e.id = $1',
    [entry.legal_entity_id],
  );
  const functional = fn.rows[0]!.functional_currency.trim();
  let rate = '1';
  let rateId: string | null = null;
  if (entry.rate_locked) {
    rate = entry.exchange_rate!;
    rateId = entry.rate_id;
  } else if (entry.currency.trim() !== functional) {
    const r = await tx.query<{ id: string; rate: string }>(
      `SELECT id, rate FROM exchange_rates
        WHERE organization_id = $1 AND from_currency = $2 AND to_currency = $3 AND status = 'approved' AND effective_date <= $4::date
        ORDER BY effective_date DESC LIMIT 1`,
      [organizationId, entry.currency, functional, entry.posting_date],
    );
    if (!r.rows[0]) throw invalid(`No approved ${entry.currency.trim()}->${functional} exchange rate on or before ${entry.posting_date}`);
    rate = r.rows[0].rate;
    rateId = r.rows[0].id;
  }

  const sameCurrency = entry.currency.trim() === functional;
  let fd = 0n;
  let fc = 0n;
  for (const l of lines) {
    const d = BigInt(l.debit_minor);
    const c = BigInt(l.credit_minor);
    const conv = (v: bigint) => (v === 0n ? 0n : sameCurrency ? v : convertMinor(v, rate, cur.rows[0]!.minor_unit, fn.rows[0]!.minor_unit));
    const fdl = conv(d);
    const fcl = conv(c);
    fd += fdl;
    fc += fcl;
    await tx.query('UPDATE journal_lines SET functional_debit_minor = $2, functional_credit_minor = $3 WHERE id = $1', [l.id, fdl, fcl]);
  }

  const diff = fd - fc;
  if (diff !== 0n) {
    const abs = diff < 0n ? -diff : diff;
    if (abs > BigInt(lines.length)) throw invalid('Currency conversion left an unexpected imbalance');
    const s = await tx.query<{ fx_rounding_account_id: string | null }>('SELECT fx_rounding_account_id FROM accounting_settings WHERE legal_entity_id = $1', [entry.legal_entity_id]);
    const roundingAccount = s.rows[0]?.fx_rounding_account_id;
    if (!roundingAccount) throw invalid('Currency rounding left a difference; configure an FX rounding account for this legal entity');
    await tx.query(
      `INSERT INTO journal_lines (entry_id, line_no, account_id, functional_debit_minor, functional_credit_minor, description, is_fx_rounding)
       VALUES ($1, $2, $3, $4, $5, 'FX rounding', true)`,
      [entryId, lines.length + 1, roundingAccount, diff < 0n ? abs : 0n, diff > 0n ? abs : 0n],
    );
  }

  const journalNumber = await nextDocumentNumber(tx, organizationId, entry.legal_entity_id, 'JE', 'JE');
  await tx.query(
    `UPDATE journal_entries SET status = 'posted', journal_number = $2, period_id = $3, exchange_rate = $4, rate_id = $5,
            posted_by = $6, posted_at = now() WHERE id = $1`,
    [entryId, journalNumber, p.id, rate, rateId, actorUserId],
  );
  if (entry.reverses_entry_id) {
    await tx.query('UPDATE journal_entries SET reversed_by_entry_id = $2 WHERE id = $1', [entry.reverses_entry_id, entryId]);
  }
  return { journalNumber };
}
