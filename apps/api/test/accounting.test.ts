import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newOrg, setupApp, staff } from './helpers.js';
import { cmd } from './inventory-helpers.js';
import { approvedRate, book, buildBooks, buildWorld, cr, dr, draft, post, trialBalance, type Books } from './accounting-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

const books = async () => buildBooks(ctx.app, await buildWorld(ctx.app, await newOrg(ctx.db)));
const tbOf = (r: any, code: string) => r.body.accounts.find((a: any) => a.code === code);

describe('chart of accounts', () => {
  it('keeps codes unique per entity, validates parents and refuses postings to headers', async () => {
    const b = await books();
    const dup = await call(ctx.app, 'POST', '/v1/accounting/accounts', b.org.auth, { legalEntityId: b.ng, code: '1000', name: 'Dup', type: 'asset' });
    expect(dup.status).toBe(409);
    const postableParent = await call(ctx.app, 'POST', '/v1/accounting/accounts', b.org.auth, { legalEntityId: b.ng, code: '1002', name: 'X', type: 'asset', parentId: b.acc.cash });
    expect(postableParent.status).toBe(422);
    const wrongType = await call(ctx.app, 'POST', '/v1/accounting/accounts', b.org.auth, { legalEntityId: b.ng, code: '1003', name: 'X', type: 'liability', parentId: b.acc.header });
    expect(wrongType.status).toBe(422);
    const hdr = await draft(ctx.app, b, [dr(b.acc.header, 100), cr(b.acc.equity, 100)]);
    expect(hdr.status).toBe(422);
    expect((await call(ctx.app, 'GET', `/v1/accounting/accounts?legalEntityId=${b.ng}`, b.bookkeeper.auth)).body).toHaveLength(9);
    expect((await call(ctx.app, 'POST', '/v1/accounting/accounts', b.bookkeeper.auth, { legalEntityId: b.ng, code: '9', name: 'N', type: 'asset' })).status).toBe(403);
  });

  it('refuses archived accounts and accounts of another entity', async () => {
    const b = await books();
    await call(ctx.app, 'POST', `/v1/accounting/accounts/${b.acc.rent}/archive`, b.org.auth);
    expect((await draft(ctx.app, b, [dr(b.acc.rent, 100), cr(b.acc.cash, 100)])).status).toBe(422);
    expect((await draft(ctx.app, b, [dr(b.ghCash, 100), cr(b.acc.cash, 100)])).status).toBe(422);
  });
});

describe('journals', () => {
  it('rejects malformed or unbalanced journals', async () => {
    const b = await books();
    const bad = async (lines: unknown[], extra = {}) => (await draft(ctx.app, b, lines, extra)).status;
    expect(await bad([dr(b.acc.cash, 100), cr(b.acc.equity, 99)])).toBe(422);
    expect(await bad([dr(b.acc.cash, 100)])).toBe(400);
    expect(await bad([{ accountId: b.acc.cash, debitMinor: 100, creditMinor: 100 }, cr(b.acc.equity, 0)])).toBe(422);
    expect(await bad([dr(b.acc.cash, 0), cr(b.acc.equity, 0)])).toBe(422);
    expect(await bad([dr(b.acc.cash, 1.5), cr(b.acc.equity, 1.5)])).toBe(400);
    expect(await bad([dr(b.acc.cash, 100), cr(b.acc.equity, 100)], { currency: 'QQQ' })).toBe(422);
    // A USD-only bank account refuses an NGN journal; the same lines in USD are accepted as a draft.
    expect(await bad([dr(b.acc.bankUsd, 100), cr(b.acc.equity, 100)])).toBe(422);
    expect(await bad([dr(b.acc.bankUsd, 100), cr(b.acc.equity, 100)], { currency: 'USD' })).toBe(201);
    const foreignLoc = await bad([dr(b.acc.cash, 100, { locationId: b.g1 }), cr(b.acc.equity, 100)]);
    expect(foreignLoc).toBe(422);
  });

  it('are drafted by one person and posted by another, with gap-free numbers', async () => {
    const b = await books();
    const d1 = await draft(ctx.app, b, [dr(b.acc.cash, 100000), cr(b.acc.equity, 100000)], { description: 'Opening capital' });
    expect(d1.body).toMatchObject({ status: 'draft', journalNumber: null });
    expect((await post(ctx.app, b, d1.body.id, b.bookkeeper.auth)).status).toBe(403);   // lacks accounting.post
    const both = await staff(ctx.app, b.org.auth, ['accounting.journal', 'accounting.post'], { type: 'legal_entity', id: b.ng });
    const own = await draft(ctx.app, b, [dr(b.acc.cash, 5), cr(b.acc.equity, 5)], {}, both.auth);
    expect((await post(ctx.app, b, own.body.id, both.auth)).status).toBe(403);           // cannot post own journal
    await cmd(ctx.app, b.org.auth, `/v1/accounting/journals/${own.body.id}/post`, {});   // org admin posts it
    expect((await call(ctx.app, 'GET', `/v1/accounting/journals/${own.body.id}`, b.org.auth)).body.journalNumber).toBe('JE-000001');

    const ok = await post(ctx.app, b, d1.body.id);
    expect(ok.body).toMatchObject({ status: 'posted', journalNumber: 'JE-000002', exchangeRate: '1', postedBy: b.accountant.userId });
    expect(ok.body.lines[0]).toMatchObject({ functionalDebitMinor: 100000, functionalCreditMinor: 0 });
    expect((await post(ctx.app, b, d1.body.id)).status).toBe(409);
  });

  it('can be edited or deleted while draft, never once posted', async () => {
    const b = await books();
    const d = await draft(ctx.app, b, [dr(b.acc.cash, 100), cr(b.acc.equity, 100)]);
    const edited = await call(ctx.app, 'PUT', `/v1/accounting/journals/${d.body.id}`, b.bookkeeper.auth, { description: 'Fixed', lines: [dr(b.acc.cash, 250), cr(b.acc.equity, 250)] });
    expect(edited.body).toMatchObject({ description: 'Fixed' });
    expect(edited.body.lines[0].debitMinor).toBe(250);
    expect((await call(ctx.app, 'PUT', `/v1/accounting/journals/${d.body.id}`, b.bookkeeper.auth, { lines: [dr(b.acc.cash, 1), cr(b.acc.equity, 2)] })).status).toBe(422);
    const gone = await draft(ctx.app, b, [dr(b.acc.cash, 1), cr(b.acc.equity, 1)]);
    expect((await call(ctx.app, 'DELETE', `/v1/accounting/journals/${gone.body.id}`, b.bookkeeper.auth)).status).toBe(204);

    await post(ctx.app, b, d.body.id);
    expect((await call(ctx.app, 'PUT', `/v1/accounting/journals/${d.body.id}`, b.bookkeeper.auth, { description: 'Sneaky' })).status).toBe(409);
    expect((await call(ctx.app, 'DELETE', `/v1/accounting/journals/${d.body.id}`, b.bookkeeper.auth)).status).toBe(409);
  });

  it('are permanent in the database even if the API is bypassed', async () => {
    const b = await books();
    const j = await book(ctx.app, b, [dr(b.acc.cash, 100), cr(b.acc.equity, 100)]);
    await expect(ctx.db.query('UPDATE journal_lines SET debit_minor = 999 WHERE entry_id = $1', [j.id])).rejects.toThrow(/immutable/);
    await expect(ctx.db.query('DELETE FROM journal_lines WHERE entry_id = $1', [j.id])).rejects.toThrow(/immutable/);
    await expect(ctx.db.query('INSERT INTO journal_lines (entry_id, line_no, account_id, debit_minor) VALUES ($1, 9, $2, 1)', [j.id, b.acc.cash])).rejects.toThrow(/immutable/);
    await expect(ctx.db.query("UPDATE journal_entries SET description = 'changed' WHERE id = $1", [j.id])).rejects.toThrow(/immutable/);
    await expect(ctx.db.query("UPDATE journal_entries SET posting_date = '2020-01-01' WHERE id = $1", [j.id])).rejects.toThrow(/immutable/);
    await expect(ctx.db.query('DELETE FROM journal_entries WHERE id = $1', [j.id])).rejects.toThrow(/cannot be deleted/);
    await expect(ctx.db.query('TRUNCATE journal_lines')).rejects.toThrow(/truncated/);
  });
});

describe('fiscal periods', () => {
  it('reject overlaps and postings with no open period, and a failed post does not use a number', async () => {
    const b = await books();
    const overlap = await call(ctx.app, 'POST', '/v1/accounting/periods', b.org.auth, { legalEntityId: b.ng, name: 'Mid', startDate: '2026-01-31', endDate: '2026-02-02' });
    expect(overlap.status).toBe(409);
    const lines = [dr(b.acc.cash, 100), cr(b.acc.equity, 100)];
    const outside = await draft(ctx.app, b, lines, { postingDate: '2026-06-15' });
    expect((await post(ctx.app, b, outside.body.id)).status).toBe(409);
    const first = await book(ctx.app, b, lines);
    expect(first.journalNumber).toBe('JE-000001');
    expect((await call(ctx.app, 'DELETE', `/v1/accounting/journals/${outside.body.id}`, b.bookkeeper.auth)).status).toBe(204);
    expect((await book(ctx.app, b, lines)).journalNumber).toBe('JE-000002');
  });

  it('close only without drafts, then block postings, and reopen needs another person and a reason', async () => {
    const b = await books();
    const lines = [dr(b.acc.cash, 100), cr(b.acc.equity, 100)];
    const pending = await draft(ctx.app, b, lines, { postingDate: '2026-02-10' });
    expect((await cmd(ctx.app, b.controller.auth, `/v1/accounting/periods/${b.feb}/close`, {})).status).toBe(409);
    await post(ctx.app, b, pending.body.id);
    expect((await cmd(ctx.app, b.bookkeeper.auth, `/v1/accounting/periods/${b.feb}/close`, {})).status).toBe(403);
    expect((await cmd(ctx.app, b.controller.auth, `/v1/accounting/periods/${b.feb}/close`, {})).body.status).toBe('closed');
    expect((await cmd(ctx.app, b.controller.auth, `/v1/accounting/periods/${b.feb}/close`, {})).status).toBe(409);

    const late = await draft(ctx.app, b, lines, { postingDate: '2026-02-20' });
    const blocked = await post(ctx.app, b, late.body.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/closed/);

    const both = await staff(ctx.app, b.org.auth, ['accounting.period.close', 'accounting.period.reopen'], { type: 'legal_entity', id: b.ng });
    expect((await cmd(ctx.app, b.controller.auth, `/v1/accounting/periods/${b.feb}/reopen`, { reason: 'Late invoice' })).status).toBe(403);  // closer cannot reopen
    expect((await cmd(ctx.app, both.auth, `/v1/accounting/periods/${b.feb}/reopen`, { reason: 'no' })).status).toBe(400);
    const open = await cmd(ctx.app, both.auth, `/v1/accounting/periods/${b.feb}/reopen`, { reason: 'Late supplier invoice' });
    expect(open.body).toMatchObject({ status: 'open', reopenReason: 'Late supplier invoice' });
    expect((await post(ctx.app, b, late.body.id)).status).toBe(200);
    const log = await call(ctx.app, 'GET', `/v1/audit-log?entityType=fiscal_period&entityId=${b.feb}`, b.org.auth);
    expect(log.body.map((e: any) => e.action)).toEqual(expect.arrayContaining(['period.close', 'period.reopen']));
  });
});

describe('trial balance and ledger', () => {
  it('balances, satisfies the accounting equation and honours the as-of date', async () => {
    const b = await books();
    await book(ctx.app, b, [dr(b.acc.cash, 100000), cr(b.acc.equity, 100000)], { postingDate: '2026-01-05', description: 'Capital' });
    await book(ctx.app, b, [dr(b.acc.rent, 30000), cr(b.acc.cash, 30000)], { postingDate: '2026-01-10', description: 'January rent' });
    await book(ctx.app, b, [dr(b.acc.cash, 50000), cr(b.acc.sales, 50000)], { postingDate: '2026-01-20', description: 'Sales' });
    await draft(ctx.app, b, [dr(b.acc.cash, 999), cr(b.acc.sales, 999)]); // drafts never count

    const tb = await trialBalance(ctx.app, b);
    expect(tb.body.currency).toBe('NGN');
    expect(tb.body.totals).toEqual({ debitMinor: 180000, creditMinor: 180000, balanced: true });
    expect(tb.body.accountingEquation).toEqual({ assetsPlusExpensesMinor: 150000, liabilitiesEquityRevenueMinor: 150000, holds: true });
    expect(tbOf(tb, '1000')).toMatchObject({ debitMinor: 150000, creditMinor: 30000, balanceMinor: 120000 });
    expect(tb.body.accounts.map((a: any) => a.code)).toEqual(['1000', '3000', '4000', '5000']);

    const early = await trialBalance(ctx.app, b, '2026-01-12');
    expect(early.body.totals.debitMinor).toBe(130000);
    expect(tbOf(early, '4000')).toBeUndefined();
    const ranged = await trialBalance(ctx.app, b, '2026-01-31', b.org.auth, '&from=2026-01-15');
    expect(ranged.body.totals.debitMinor).toBe(50000);
    expect((await trialBalance(ctx.app, b, '2026-12-31', b.org.auth, '&includeZero=true')).body.accounts.length).toBe(9);
  });

  it('gives an account ledger with a running balance in its normal direction', async () => {
    const b = await books();
    await book(ctx.app, b, [dr(b.acc.cash, 100000), cr(b.acc.equity, 100000)], { postingDate: '2026-01-05' });
    await book(ctx.app, b, [dr(b.acc.rent, 30000), cr(b.acc.cash, 30000)], { postingDate: '2026-01-10' });
    await book(ctx.app, b, [dr(b.acc.cash, 50000), cr(b.acc.sales, 50000)], { postingDate: '2026-01-20' });
    const cash = await call(ctx.app, 'GET', `/v1/accounting/accounts/${b.acc.cash}/ledger`, b.org.auth);
    expect(cash.body.entries.map((e: any) => e.balanceMinor)).toEqual([100000, 70000, 120000]);
    expect(cash.body.closingBalanceMinor).toBe(120000);
    const partial = await call(ctx.app, 'GET', `/v1/accounting/accounts/${b.acc.cash}/ledger?from=2026-01-15`, b.org.auth);
    expect(partial.body).toMatchObject({ openingBalanceMinor: 70000, closingBalanceMinor: 120000 });
    const equity = await call(ctx.app, 'GET', `/v1/accounting/accounts/${b.acc.equity}/ledger`, b.org.auth);
    expect(equity.body.closingBalanceMinor).toBe(100000);   // credit-normal shown positive
  });
});

describe('reversals', () => {
  it('create a swapped draft that another person posts, once only', async () => {
    const b = await books();
    const j = await book(ctx.app, b, [dr(b.acc.rent, 30000), cr(b.acc.cash, 30000)], { postingDate: '2026-01-10' });
    const reverse = (auth = b.bookkeeper.auth, body: any = { postingDate: '2026-01-25', reason: 'Booked twice' }) => cmd(ctx.app, auth, `/v1/accounting/journals/${j.id}/reverse`, body);

    expect((await reverse(b.bookkeeper.auth, { postingDate: '2026-01-09', reason: 'Booked twice' })).status).toBe(409);
    const rev = await reverse();
    expect(rev.status).toBe(201);
    expect(rev.body).toMatchObject({ status: 'draft', sourceType: 'reversal', reversesEntryId: j.id });
    expect(rev.body.description).toContain('JE-000001');
    expect(rev.body.lines.map((l: any) => [l.debitMinor, l.creditMinor])).toEqual([[0, 30000], [30000, 0]]);
    expect((await reverse()).status).toBe(409);                       // one pending reversal at a time

    expect((await post(ctx.app, b, rev.body.id, b.bookkeeper.auth)).status).toBe(403);
    const posted = await post(ctx.app, b, rev.body.id);
    expect(posted.body.status).toBe('posted');
    const original = await call(ctx.app, 'GET', `/v1/accounting/journals/${j.id}`, b.org.auth);
    expect(original.body.reversedByEntryId).toBe(rev.body.id);
    expect((await reverse()).status).toBe(409);                       // already reversed

    const tb = await trialBalance(ctx.app, b);
    expect(tb.body.totals).toMatchObject({ debitMinor: 60000, creditMinor: 60000, balanced: true });
    expect(tbOf(tb, '5000')).toMatchObject({ debitMinor: 30000, creditMinor: 30000, balanceMinor: 0 });
    expect((await cmd(ctx.app, b.bookkeeper.auth, `/v1/accounting/journals/${rev.body.id}/reverse`, { postingDate: '2026-01-26', reason: 'Reverse the reversal' })).status).toBe(201);
  });

  it('only apply to posted journals, and a deleted draft reversal can be retried', async () => {
    const b = await books();
    const d = await draft(ctx.app, b, [dr(b.acc.cash, 1), cr(b.acc.equity, 1)]);
    expect((await cmd(ctx.app, b.bookkeeper.auth, `/v1/accounting/journals/${d.body.id}/reverse`, { postingDate: '2026-01-11', reason: 'Too early' })).status).toBe(409);
    const j = await book(ctx.app, b, [dr(b.acc.cash, 5), cr(b.acc.equity, 5)]);
    const rev = await cmd(ctx.app, b.bookkeeper.auth, `/v1/accounting/journals/${j.id}/reverse`, { postingDate: '2026-01-11', reason: 'Try one' });
    await call(ctx.app, 'DELETE', `/v1/accounting/journals/${rev.body.id}`, b.bookkeeper.auth);
    expect((await cmd(ctx.app, b.bookkeeper.auth, `/v1/accounting/journals/${j.id}/reverse`, { postingDate: '2026-01-12', reason: 'Try two' })).status).toBe(201);
  });
});

describe('foreign currency', () => {
  it('needs an approved rate, which a second person must approve', async () => {
    const b = await books();
    const lines = [dr(b.acc.bankUsd, 10000), cr(b.acc.equity, 10000)];
    const d = await draft(ctx.app, b, lines, { currency: 'USD' });
    const none = await post(ctx.app, b, d.body.id);
    expect(none.status).toBe(422);

    const rate = await call(ctx.app, 'POST', '/v1/accounting/exchange-rates', b.org.auth, { fromCurrency: 'USD', toCurrency: 'NGN', rate: '1500.5', effectiveDate: '2026-01-01', source: 'Central bank' });
    expect(rate.status).toBe(201);
    expect((await post(ctx.app, b, d.body.id)).status).toBe(422);                                       // pending rates are not used
    expect((await call(ctx.app, 'POST', `/v1/accounting/exchange-rates/${rate.body.id}/approve`, b.org.auth)).status).toBe(403);  // cannot approve own rate
    expect((await call(ctx.app, 'POST', `/v1/accounting/exchange-rates/${rate.body.id}/approve`, b.bookkeeper.auth)).status).toBe(403);
    expect((await call(ctx.app, 'POST', `/v1/accounting/exchange-rates/${rate.body.id}/approve`, b.rateApprover.auth)).status).toBe(200);
    expect((await call(ctx.app, 'POST', `/v1/accounting/exchange-rates/${rate.body.id}/approve`, b.rateApprover.auth)).status).toBe(409);

    const ok = await post(ctx.app, b, d.body.id);
    expect(ok.body).toMatchObject({ status: 'posted', currency: 'USD', exchangeRate: '1500.5' });
    expect(ok.body.lines[0]).toMatchObject({ debitMinor: 10000, functionalDebitMinor: 15005000 });      // USD 100.00 -> NGN 150,050.00
    const tb = await trialBalance(ctx.app, b);
    expect(tbOf(tb, '1010').debitMinor).toBe(15005000);
    expect(tb.body.totals.balanced).toBe(true);
  });

  it('uses the latest approved rate on or before the posting date', async () => {
    const b = await books();
    await approvedRate(ctx.app, b, 'USD', '1500', '2026-01-01');
    await approvedRate(ctx.app, b, 'USD', '1600', '2026-01-20');
    const rejected = await call(ctx.app, 'POST', '/v1/accounting/exchange-rates', b.org.auth, { fromCurrency: 'USD', toCurrency: 'NGN', rate: '9999', effectiveDate: '2026-01-25', source: 'Typo' });
    await call(ctx.app, 'POST', `/v1/accounting/exchange-rates/${rejected.body.id}/reject`, b.rateApprover.auth);
    const lines = [dr(b.acc.bankUsd, 100), cr(b.acc.equity, 100)];
    const at = async (postingDate: string) => (await book(ctx.app, b, lines, { currency: 'USD', postingDate })).exchangeRate;
    expect(await at('2026-01-10')).toBe('1500');
    expect(await at('2026-01-20')).toBe('1600');
    expect(await at('2026-01-30')).toBe('1600');
    // A rejected rate frees its date for a corrected entry.
    expect((await call(ctx.app, 'POST', '/v1/accounting/exchange-rates', b.org.auth, { fromCurrency: 'USD', toCurrency: 'NGN', rate: '1610', effectiveDate: '2026-01-25', source: 'Corrected' })).status).toBe(201);
    expect((await call(ctx.app, 'POST', '/v1/accounting/exchange-rates', b.org.auth, { fromCurrency: 'USD', toCurrency: 'NGN', rate: '1611', effectiveDate: '2026-01-25', source: 'Duplicate' })).status).toBe(409);
  });

  it('balances rounding differences through the configured FX rounding account', async () => {
    const b = await books();
    await approvedRate(ctx.app, b, 'USD', '1.0005', '2026-01-01');
    // USD 10.00 = 1,000.5 -> 1,001 ; two credits of 5.00 = 500.25 each -> 500 ; functional debits exceed credits by 1
    const lines = [dr(b.acc.cash, 1000), cr(b.acc.equity, 500), cr(b.acc.sales, 500)];
    const d = await draft(ctx.app, b, lines, { currency: 'USD' });
    const noAccount = await post(ctx.app, b, d.body.id);
    expect(noAccount.status).toBe(422);
    expect(noAccount.body.message).toMatch(/rounding account/);

    const badSetting = await call(ctx.app, 'PUT', `/v1/accounting/settings/${b.ng}`, b.org.auth, { fxRoundingAccountId: b.acc.header });
    expect(badSetting.status).toBe(422);
    expect((await call(ctx.app, 'PUT', `/v1/accounting/settings/${b.ng}`, b.org.auth, { fxRoundingAccountId: b.acc.fxr })).status).toBe(200);
    const ok = await post(ctx.app, b, d.body.id);
    expect(ok.status).toBe(200);
    const rounding = ok.body.lines.find((l: any) => l.isFxRounding);
    expect(rounding).toMatchObject({ accountCode: '5900', debitMinor: 0, creditMinor: 0, functionalCreditMinor: 1, functionalDebitMinor: 0 });
    const tb = await trialBalance(ctx.app, b);
    expect(tb.body.totals).toMatchObject({ debitMinor: 1001, creditMinor: 1001, balanced: true });
    expect(tbOf(tb, '5900')).toMatchObject({ creditMinor: 1 });
  });

  it('reverses at the original rate even after the rate changes', async () => {
    const b = await books();
    await approvedRate(ctx.app, b, 'USD', '1500.5', '2026-01-01');
    const j = await book(ctx.app, b, [dr(b.acc.bankUsd, 10000), cr(b.acc.equity, 10000)], { currency: 'USD', postingDate: '2026-01-10' });
    await approvedRate(ctx.app, b, 'USD', '1700', '2026-01-20');
    const rev = await cmd(ctx.app, b.bookkeeper.auth, `/v1/accounting/journals/${j.id}/reverse`, { postingDate: '2026-01-25', reason: 'Wrong bank' });
    const posted = await post(ctx.app, b, rev.body.id);
    expect(posted.body).toMatchObject({ exchangeRate: '1500.5', currency: 'USD' });
    const tb = await trialBalance(ctx.app, b);
    expect(tbOf(tb, '1010')).toMatchObject({ debitMinor: 15005000, creditMinor: 15005000, balanceMinor: 0 });
    expect(tbOf(tb, '3000')).toMatchObject({ balanceMinor: 0 });
  });
});

describe('access and audit', () => {
  it('limits access by legal entity and organization', async () => {
    const b = await books();
    await book(ctx.app, b, [dr(b.acc.cash, 100), cr(b.acc.equity, 100)]);
    const ghReader = await staff(ctx.app, b.org.auth, ['accounting.read'], { type: 'legal_entity', id: b.gh });
    expect((await trialBalance(ctx.app, b, '2026-12-31', ghReader.auth)).status).toBe(403);
    expect((await call(ctx.app, 'GET', `/v1/accounting/accounts?legalEntityId=${b.ng}`, ghReader.auth)).status).toBe(403);
    expect((await call(ctx.app, 'GET', '/v1/accounting/journals', ghReader.auth)).body).toEqual([]);
    expect((await call(ctx.app, 'GET', '/v1/accounting/journals', b.accountant.auth)).body).toHaveLength(1);
    expect((await call(ctx.app, 'POST', '/v1/accounting/journals', ghReader.auth, { legalEntityId: b.ng, postingDate: '2026-01-10', description: 'x', lines: [] })).status).toBe(400);

    const other = await books();
    expect((await trialBalance(ctx.app, b, '2026-12-31', other.org.auth)).status).toBe(404);
    const mine = await call(ctx.app, 'GET', '/v1/accounting/journals', b.org.auth);
    expect((await call(ctx.app, 'GET', `/v1/accounting/journals/${mine.body[0].id}`, other.org.auth)).status).toBe(404);
    expect((await call(ctx.app, 'GET', `/v1/accounting/accounts/${b.acc.cash}/ledger`, other.org.auth)).status).toBe(404);
  });

  it('audits drafting and posting with the actor', async () => {
    const b = await books();
    const j = await book(ctx.app, b, [dr(b.acc.cash, 100), cr(b.acc.equity, 100)]);
    const log = await call(ctx.app, 'GET', `/v1/audit-log?entityType=journal&entityId=${j.id}`, b.org.auth);
    const byAction = Object.fromEntries(log.body.map((e: any) => [e.action, e.actorUserId]));
    expect(byAction).toEqual({ 'journal.create': b.bookkeeper.userId, 'journal.post': b.accountant.userId });
  });
});
