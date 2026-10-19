import type { Db, Tx } from '../db.js';
import { withTx } from '../db.js';
import { AppError } from '../errors.js';
import type { DomainEvent, InternalConsumer } from '../events/dispatcher.js';
import { replaceLines, validateDraftLines, type DraftLine } from './posting.js';

export type Outcome =
  | { status: 'drafted'; journalId: string }
  | { status: 'exists'; journalId: string }
  | { status: 'skipped'; reason: string }
  | { status: 'disabled' }      // no rules, or rules switched off: nothing to do and nothing to report
  | { status: 'not_ready' };    // the document is not in a state that posts (for example, awaiting payment)

export const POS_ROLES = ['cash', 'card', 'bank_transfer', 'mobile_money', 'salesRevenue', 'salesTaxPayable'] as const;
export type PosRole = (typeof POS_ROLES)[number];
type Accounts = Partial<Record<PosRole, string>>;

async function rulesFor(tx: Tx, legalEntityId: string): Promise<Accounts | null> {
  const { rows } = await tx.query<{ enabled: boolean; accounts: Accounts }>(
    `SELECT enabled, accounts FROM posting_rule_sets WHERE legal_entity_id = $1 AND kind = 'pos_revenue'`,
    [legalEntityId],
  );
  return rows[0]?.enabled ? rows[0].accounts : null;
}

async function existing(tx: Tx, legalEntityId: string, sourceType: string, sourceId: string): Promise<string | null> {
  const r = await tx.query<{ id: string }>('SELECT id FROM journal_entries WHERE legal_entity_id = $1 AND source_type = $2 AND source_id = $3', [legalEntityId, sourceType, sourceId]);
  return r.rows[0]?.id ?? null;
}

async function createDraft(
  tx: Tx, organizationId: string, legalEntityId: string, sourceType: 'pos_sale' | 'pos_return', sourceId: string,
  postingDate: string, description: string, currency: string, createdBy: string, lines: DraftLine[],
): Promise<Outcome> {
  try {
    await validateDraftLines(tx, organizationId, legalEntityId, currency, lines);
  } catch (err) {
    if (err instanceof AppError) return { status: 'skipped', reason: err.message };
    throw err;
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO journal_entries (organization_id, legal_entity_id, posting_date, description, source_type, source_id, currency, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [organizationId, legalEntityId, postingDate, description, sourceType, sourceId, currency, createdBy],
  );
  await replaceLines(tx, rows[0]!.id, lines);
  return { status: 'drafted', journalId: rows[0]!.id };
}

const skip = (reason: string): Outcome => ({ status: 'skipped', reason });

/**
 * Drafts the revenue journal for a completed sale: debit a clearing account for each payment method, credit sales
 * revenue (net of tax) and sales tax payable. Revenue is recognised at the sale; that timing is a policy for finance to confirm.
 */
export async function draftForSale(tx: Tx, saleId: string): Promise<Outcome> {
  const s = await tx.query<{
    organization_id: string; legal_entity_id: string; location_id: string; status: string; receipt_number: string; currency: string;
    tax_minor: string; total_minor: string; cashier_id: string; posting_date: string;
  }>(
    `SELECT s.organization_id, s.legal_entity_id, s.location_id, s.status, s.receipt_number, s.currency, s.tax_minor, s.total_minor, s.cashier_id,
            ((COALESCE(s.completed_at, s.created_at)) AT TIME ZONE l.timezone)::date::text AS posting_date
       FROM pos_sales s JOIN locations l ON l.id = s.location_id WHERE s.id = $1`,
    [saleId],
  );
  const sale = s.rows[0];
  if (!sale || sale.status !== 'completed') return { status: 'not_ready' };
  const accounts = await rulesFor(tx, sale.legal_entity_id);
  if (!accounts) return { status: 'disabled' };
  const have = await existing(tx, sale.legal_entity_id, 'pos_sale', saleId);
  if (have) return { status: 'exists', journalId: have };

  const pay = await tx.query<{ method: string; amount: string }>(`SELECT method, sum(amount_minor) AS amount FROM pos_payments WHERE sale_id = $1 AND status = 'confirmed' GROUP BY method ORDER BY method`, [saleId]);
  const total = BigInt(sale.total_minor);
  const tax = BigInt(sale.tax_minor);
  if (pay.rows.reduce((a, p) => a + BigInt(p.amount), 0n) !== total) return skip('Confirmed payments do not add up to the sale total');
  if (!accounts.salesRevenue) return skip('No sales revenue account is mapped');
  if (tax > 0n && !accounts.salesTaxPayable) return skip('The sale has tax but no sales tax payable account is mapped');

  const lines: DraftLine[] = [];
  for (const p of pay.rows) {
    const account = accounts[p.method as PosRole];
    if (!account) return skip(`No clearing account is mapped for ${p.method} payments`);
    lines.push({ accountId: account, debitMinor: Number(p.amount), creditMinor: 0, description: `${p.method} received`, locationId: sale.location_id });
  }
  lines.push({ accountId: accounts.salesRevenue, debitMinor: 0, creditMinor: Number(total - tax), description: 'Sales revenue', locationId: sale.location_id });
  if (tax > 0n) lines.push({ accountId: accounts.salesTaxPayable!, debitMinor: 0, creditMinor: Number(tax), description: 'Sales tax', locationId: sale.location_id });
  return createDraft(tx, sale.organization_id, sale.legal_entity_id, 'pos_sale', saleId, sale.posting_date, `POS sale ${sale.receipt_number}`, sale.currency.trim(), sale.cashier_id, lines);
}

/** The mirror image for a return: debit revenue and tax, credit the clearing account of the refund method. */
export async function draftForReturn(tx: Tx, returnId: string): Promise<Outcome> {
  const r = await tx.query<{
    organization_id: string; legal_entity_id: string; location_id: string; return_number: string; receipt_number: string; currency: string;
    refund_method: string; refund_total_minor: string; processed_by: string; posting_date: string; tax_refund: string;
  }>(
    `SELECT s.organization_id, s.legal_entity_id, s.location_id, r.return_number, s.receipt_number, s.currency, r.refund_method, r.refund_total_minor, r.processed_by,
            (r.created_at AT TIME ZONE l.timezone)::date::text AS posting_date,
            COALESCE((SELECT sum(tax_refund_minor) FROM pos_return_lines WHERE return_id = r.id), 0) AS tax_refund
       FROM pos_returns r JOIN pos_sales s ON s.id = r.sale_id JOIN locations l ON l.id = s.location_id WHERE r.id = $1`,
    [returnId],
  );
  const ret = r.rows[0];
  if (!ret) return { status: 'not_ready' };
  const accounts = await rulesFor(tx, ret.legal_entity_id);
  if (!accounts) return { status: 'disabled' };
  const have = await existing(tx, ret.legal_entity_id, 'pos_return', returnId);
  if (have) return { status: 'exists', journalId: have };

  const refund = BigInt(ret.refund_total_minor);
  const tax = BigInt(ret.tax_refund);
  if (refund === 0n) return skip('The refund amount is zero');
  if (!accounts.salesRevenue) return skip('No sales revenue account is mapped');
  if (tax > 0n && !accounts.salesTaxPayable) return skip('The return has tax but no sales tax payable account is mapped');
  const clearing = accounts[ret.refund_method as PosRole];
  if (!clearing) return skip(`No clearing account is mapped for ${ret.refund_method} payments`);

  const lines: DraftLine[] = [{ accountId: accounts.salesRevenue, debitMinor: Number(refund - tax), creditMinor: 0, description: 'Sales returned', locationId: ret.location_id }];
  if (tax > 0n) lines.push({ accountId: accounts.salesTaxPayable!, debitMinor: Number(tax), creditMinor: 0, description: 'Sales tax reversed', locationId: ret.location_id });
  lines.push({ accountId: clearing, debitMinor: 0, creditMinor: Number(refund), description: `${ret.refund_method} refunded`, locationId: ret.location_id });
  return createDraft(tx, ret.organization_id, ret.legal_entity_id, 'pos_return', returnId, ret.posting_date, `POS return ${ret.return_number} (sale ${ret.receipt_number})`, ret.currency.trim(), ret.processed_by, lines);
}

/** Records drafted and skipped outcomes so finance can see them. Quiet outcomes (disabled, not ready, exists) leave no trace. */
export async function record(tx: Tx, sourceType: 'pos_sale' | 'pos_return', sourceId: string, organizationId: string, legalEntityId: string, o: Outcome): Promise<void> {
  if (o.status !== 'drafted' && o.status !== 'skipped') return;
  await tx.query(
    `INSERT INTO posting_log (source_type, source_id, organization_id, legal_entity_id, status, reason, journal_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (source_type, source_id) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, journal_id = EXCLUDED.journal_id, updated_at = now()`,
    [sourceType, sourceId, organizationId, legalEntityId, o.status, o.status === 'skipped' ? o.reason : null, o.status === 'drafted' ? o.journalId : null],
  );
}

export async function processSource(db: Db | Tx, sourceType: 'pos_sale' | 'pos_return', sourceId: string): Promise<Outcome> {
  const run = async (tx: Tx) => {
    const o = sourceType === 'pos_sale' ? await draftForSale(tx, sourceId) : await draftForReturn(tx, sourceId);
    const ids = await tx.query<{ organization_id: string; legal_entity_id: string }>(
      sourceType === 'pos_sale' ? 'SELECT organization_id, legal_entity_id FROM pos_sales WHERE id = $1' : 'SELECT s.organization_id, s.legal_entity_id FROM pos_returns r JOIN pos_sales s ON s.id = r.sale_id WHERE r.id = $1',
      [sourceId],
    );
    if (ids.rows[0]) await record(tx, sourceType, sourceId, ids.rows[0].organization_id, ids.rows[0].legal_entity_id, o);
    return o;
  };
  return 'release' in db ? run(db as Tx) : withTx(db as Db, run);
}

export const posRevenueConsumer: InternalConsumer = {
  name: 'pos-revenue-posting',
  patterns: ['pos.sale', 'pos.payment_verify', 'pos.return'],
  async handle(db: Db, ev: DomainEvent) {
    if (ev.type === 'pos.return') {
      await processSource(db, 'pos_return', ev.aggregateId);
      return;
    }
    // A sale completes either when it is created (all cash) or when its last payment is verified.
    let saleId = ev.aggregateId;
    if (ev.type === 'pos.payment_verify') {
      const p = await db.query<{ sale_id: string }>('SELECT sale_id FROM pos_payments WHERE id = $1', [ev.aggregateId]);
      if (!p.rows[0]) return;
      saleId = p.rows[0].sale_id;
    }
    await processSource(db, 'pos_sale', saleId);
  },
};
