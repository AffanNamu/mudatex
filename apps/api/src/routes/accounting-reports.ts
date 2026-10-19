import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize } from '../auth/authorize.js';
import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import { uuid } from '../inventory/common.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const accountingReportRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  // Amounts are in the legal entity's functional currency, in minor units, from posted journals only.
  app.get('/accounting/trial-balance', async (req) => {
    const q = z.object({ legalEntityId: uuid, asOf: date, from: date.optional(), includeZero: z.coerce.boolean().default(false) }).parse(req.query);
    await authorize(db, req.actor, 'accounting.read', { kind: 'legal_entity', legalEntityId: q.legalEntityId });
    const le = await db.query<{ functional_currency: string }>('SELECT functional_currency FROM legal_entities WHERE id = $1 AND organization_id = $2', [q.legalEntityId, req.actor.organizationId]);
    if (!le.rows[0]) throw notFound('Legal entity');

    const { rows } = await db.query<{ id: string; code: string; name: string; type: string; d: string; c: string }>(
      `WITH posted AS (
         SELECT l.account_id, l.functional_debit_minor AS d, l.functional_credit_minor AS c
           FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.legal_entity_id = $1 AND e.status = 'posted' AND e.posting_date <= $2::date AND ($3::date IS NULL OR e.posting_date >= $3::date)
       )
       SELECT a.id, a.code, a.name, a.type, COALESCE(sum(p.d), 0) AS d, COALESCE(sum(p.c), 0) AS c
         FROM accounts a LEFT JOIN posted p ON p.account_id = a.id
        WHERE a.legal_entity_id = $1 GROUP BY a.id ORDER BY a.code`,
      [q.legalEntityId, q.asOf, q.from ?? null],
    );

    let totalD = 0n;
    let totalC = 0n;
    const net: Record<string, bigint> = { asset: 0n, liability: 0n, equity: 0n, revenue: 0n, expense: 0n };
    const accounts = rows.map((r) => {
      const d = BigInt(r.d);
      const c = BigInt(r.c);
      totalD += d;
      totalC += c;
      net[r.type]! += d - c; // debit-positive
      return { accountId: r.id, code: r.code, name: r.name, type: r.type, debitMinor: Number(d), creditMinor: Number(c), balanceMinor: Number(d - c) };
    });

    // Assets + expenses (debit-normal) must equal liabilities + equity + revenue (credit-normal).
    const left = net.asset! + net.expense!;
    const right = -(net.liability! + net.equity! + net.revenue!);
    return {
      legalEntityId: q.legalEntityId,
      currency: le.rows[0].functional_currency.trim(),
      asOf: q.asOf,
      accounts: q.includeZero ? accounts : accounts.filter((a) => a.debitMinor !== 0 || a.creditMinor !== 0),
      totals: { debitMinor: Number(totalD), creditMinor: Number(totalC), balanced: totalD === totalC },
      accountingEquation: { assetsPlusExpensesMinor: Number(left), liabilitiesEquityRevenueMinor: Number(right), holds: left === right },
    };
  });

  app.get('/accounting/accounts/:id/ledger', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = z.object({ from: date.optional(), to: date.optional() }).parse(req.query);
    const a = await db.query<{ legal_entity_id: string; code: string; name: string; type: string }>('SELECT legal_entity_id, code, name, type FROM accounts WHERE id = $1 AND organization_id = $2', [id, req.actor.organizationId]);
    const acct = a.rows[0];
    if (!acct) throw notFound('Account');
    await authorize(db, req.actor, 'accounting.read', { kind: 'legal_entity', legalEntityId: acct.legal_entity_id });

    const opening = q.from
      ? await db.query<{ b: string }>(
          `SELECT COALESCE(sum(l.functional_debit_minor - l.functional_credit_minor), 0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
            WHERE l.account_id = $1 AND e.status = 'posted' AND e.posting_date < $2::date`,
          [id, q.from],
        )
      : null;
    const { rows } = await db.query<{ d: string; c: string }>(
      `SELECT e.journal_number AS "journalNumber", e.posting_date::text AS "postingDate", e.description AS "entryDescription", l.description,
              l.functional_debit_minor AS d, l.functional_credit_minor AS c
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_id = $1 AND e.status = 'posted' AND ($2::date IS NULL OR e.posting_date >= $2::date) AND ($3::date IS NULL OR e.posting_date <= $3::date)
        ORDER BY e.posting_date, e.journal_number, l.line_no`,
      [id, q.from ?? null, q.to ?? null],
    );
    let running = BigInt(opening?.rows[0]?.b ?? '0');
    const openingBalance = running;
    const sign = acct.type === 'asset' || acct.type === 'expense' ? 1n : -1n; // present balances in the account's normal direction
    return {
      accountId: id, code: acct.code, name: acct.name, type: acct.type,
      openingBalanceMinor: Number(openingBalance * sign),
      entries: rows.map((r) => {
        const d = BigInt(r.d);
        const c = BigInt(r.c);
        running += d - c;
        return { ...r, d: undefined, c: undefined, debitMinor: Number(d), creditMinor: Number(c), balanceMinor: Number(running * sign) };
      }),
      closingBalanceMinor: Number(running * sign),
    };
  });
};
