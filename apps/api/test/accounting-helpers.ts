import type { FastifyInstance } from 'fastify';
import { call, staff, type Headers } from './helpers.js';
import { buildWorld, cmd, type World } from './inventory-helpers.js';

export interface Books extends World {
  acc: Record<'cash' | 'bankUsd' | 'ap' | 'equity' | 'sales' | 'rent' | 'fxr' | 'header' | 'child', string>;
  ghCash: string;
  jan: string;
  feb: string;
  bookkeeper: Awaited<ReturnType<typeof staff>>;
  accountant: Awaited<ReturnType<typeof staff>>;
  controller: Awaited<ReturnType<typeof staff>>;
  rateApprover: Awaited<ReturnType<typeof staff>>;
}

export async function buildBooks(app: FastifyInstance, base: World): Promise<Books> {
  const a = base.org.auth;
  const account = async (legalEntityId: string, code: string, name: string, type: string, extra: Record<string, unknown> = {}) => {
    const r = await call(app, 'POST', '/v1/accounting/accounts', a, { legalEntityId, code, name, type, ...extra });
    if (r.status !== 201) throw new Error(`account ${code}: ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  };
  const header = await account(base.ng, '1', 'Assets', 'asset', { isPostable: false });
  const acc = {
    header,
    child: await account(base.ng, '1001', 'Petty cash', 'asset', { parentId: header }),
    cash: await account(base.ng, '1000', 'Cash', 'asset'),
    bankUsd: await account(base.ng, '1010', 'USD bank', 'asset', { currency: 'USD' }),
    ap: await account(base.ng, '2000', 'Payables', 'liability'),
    equity: await account(base.ng, '3000', 'Capital', 'equity'),
    sales: await account(base.ng, '4000', 'Sales', 'revenue'),
    rent: await account(base.ng, '5000', 'Rent', 'expense'),
    fxr: await account(base.ng, '5900', 'FX rounding', 'expense'),
  };
  const ghCash = await account(base.gh, '1000', 'GH cash', 'asset');
  const period = async (name: string, startDate: string, endDate: string) => {
    const r = await call(app, 'POST', '/v1/accounting/periods', a, { legalEntityId: base.ng, name, startDate, endDate });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body.id as string;
  };
  const ng = { type: 'legal_entity', id: base.ng };
  return {
    ...base, acc, ghCash,
    jan: await period('Jan 2026', '2026-01-01', '2026-01-31'),
    feb: await period('Feb 2026', '2026-02-01', '2026-02-28'),
    bookkeeper: await staff(app, a, ['accounting.journal', 'accounting.read'], ng),
    accountant: await staff(app, a, ['accounting.post', 'accounting.read'], ng),
    controller: await staff(app, a, ['accounting.period.close', 'accounting.period.reopen', 'accounting.read'], ng),
    rateApprover: await staff(app, a, ['accounting.rates.approve', 'accounting.read'], { type: 'group' }),
  };
}

export const dr = (accountId: string, debitMinor: number, extra: Record<string, unknown> = {}) => ({ accountId, debitMinor, creditMinor: 0, ...extra });
export const cr = (accountId: string, creditMinor: number, extra: Record<string, unknown> = {}) => ({ accountId, debitMinor: 0, creditMinor, ...extra });

export function draft(app: FastifyInstance, b: Books, lines: unknown[], extra: Record<string, unknown> = {}, auth: Headers = b.bookkeeper.auth) {
  return cmd(app, auth, '/v1/accounting/journals', { legalEntityId: b.ng, postingDate: '2026-01-10', description: 'Test journal', lines, ...extra });
}

export function post(app: FastifyInstance, b: Books, id: string, auth: Headers = b.accountant.auth) {
  return cmd(app, auth, `/v1/accounting/journals/${id}/post`, {});
}

/** Drafts with the bookkeeper and posts with the accountant. */
export async function book(app: FastifyInstance, b: Books, lines: unknown[], extra: Record<string, unknown> = {}) {
  const d = await draft(app, b, lines, extra);
  if (d.status !== 201) throw new Error(`draft failed: ${JSON.stringify(d.body)}`);
  const p = await post(app, b, d.body.id);
  if (p.status !== 200) throw new Error(`post failed: ${JSON.stringify(p.body)}`);
  return p.body as any;
}

export async function approvedRate(app: FastifyInstance, b: Books, fromCurrency: string, rate: string, effectiveDate: string) {
  const r = await call(app, 'POST', '/v1/accounting/exchange-rates', b.org.auth, { fromCurrency, toCurrency: 'NGN', rate, effectiveDate, source: 'Central bank' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  const ok = await call(app, 'POST', `/v1/accounting/exchange-rates/${r.body.id}/approve`, b.rateApprover.auth);
  if (ok.status !== 200) throw new Error(JSON.stringify(ok.body));
  return r.body.id as string;
}

export const trialBalance = (app: FastifyInstance, b: Books, asOf = '2026-12-31', auth: Headers = b.org.auth, extra = '') =>
  call(app, 'GET', `/v1/accounting/trial-balance?legalEntityId=${b.ng}&asOf=${asOf}${extra}`, auth);

export { buildWorld };
