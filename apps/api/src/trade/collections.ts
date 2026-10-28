import { writeAudit } from '../audit.js';
import { withTx, type Db } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { collectionsCopy, type Stage } from '../notify/collections-copy.js';
import type { Mail, Mailer } from '../notify/mailer.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (minor: number | string | bigint, currency: string, minorUnit: number) =>
  new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: minorUnit, maximumFractionDigits: minorUnit }).format(Number(minor) / 10 ** minorUnit);

/** How long before the due date the first, friendly reminder goes out. */
export const DUE_SOON_DAYS = 3;

export interface Invoice {
  orderId: string; organizationId: string; orderNo: string; currency: string; minorUnit: number; totalMinor: number; paidMinor: number; outstandingMinor: number;
  dueOn: string; daysOverdue: number; lastNotice: { stage: string; at: string } | null;
  tradeId: string; tradeStatus: string; holdAfterDays: number; heldAutomatically: boolean; businessName: string;
  customerName: string; email: string; language: string; storeName: string; siteUrl: string | null; contact: Record<string, string | undefined>; legalEntityId: string; countryCode: string;
}

/** Every unpaid order on account for approved or held businesses, with how late it is as of `today` (a YYYY-MM-DD date). */
export async function openInvoices(db: Pick<Db, 'query'>, today: string, filter: { organizationId?: string; tradeId?: string } = {}): Promise<Invoice[]> {
  const { rows } = await db.query(
    `SELECT o.id AS "orderId", o.organization_id AS "organizationId", o.order_no AS "orderNo", o.currency, cur.minor_unit AS "minorUnit",
            o.total_minor::float8 AS "totalMinor", o.paid_minor::float8 AS "paidMinor", (o.total_minor - o.paid_minor)::float8 AS "outstandingMinor",
            o.due_on::text AS "dueOn", ($1::date - o.due_on)::int AS "daysOverdue",
            (SELECT json_build_object('stage', n.stage, 'at', n.sent_at) FROM dunning_notices n WHERE n.order_id = o.id ORDER BY n.sent_at DESC, n.id DESC LIMIT 1) AS "lastNotice",
            t.id AS "tradeId", t.status AS "tradeStatus", t.hold_after_days AS "holdAfterDays", t.held_automatically AS "heldAutomatically", t.business_name AS "businessName",
            c.full_name AS "customerName", c.email, c.language, s.name AS "storeName", s.site_url AS "siteUrl", s.contact, s.legal_entity_id AS "legalEntityId", e.country_code AS "countryCode"
       FROM sales_orders o
       JOIN trade_accounts t ON t.customer_id = o.customer_id AND t.storefront_id = o.storefront_id
       JOIN customers c ON c.id = o.customer_id
       JOIN storefronts s ON s.id = o.storefront_id
       JOIN legal_entities e ON e.id = s.legal_entity_id
       JOIN currencies cur ON cur.code = o.currency
      WHERE o.payment_method = 'account' AND o.status NOT IN ('cancelled', 'expired') AND o.total_minor > o.paid_minor AND o.due_on IS NOT NULL
        AND t.status IN ('approved', 'suspended')
        AND ($2::uuid IS NULL OR o.organization_id = $2) AND ($3::uuid IS NULL OR t.id = $3)
      ORDER BY o.due_on, o.order_no`,
    [today, filter.organizationId ?? null, filter.tradeId ?? null],
  );
  return rows as Invoice[];
}

export const stageFor = (daysOverdue: number): Stage | null =>
  daysOverdue >= 14 ? 'overdue_14' : daysOverdue >= 7 ? 'overdue_7' : daysOverdue >= 1 ? 'overdue_1' : daysOverdue >= -DUE_SOON_DAYS ? 'due_soon' : null;

export function renderReminder(stage: Stage, invoices: Invoice[], holdDays = 0): Mail {
  const first = invoices[0]!;
  const c = collectionsCopy(first.language);
  const fmt = (i: Invoice) => money(i.outstandingMinor, i.currency, i.minorUnit);
  const o = { orderNo: first.orderNo, amount: fmt(first), dueOn: first.dueOn, days: Math.max(0, first.daysOverdue), holdDays };
  const bank = first.contact.accountNumber ? [c.pay(first.contact.bankName ?? first.storeName, first.contact.accountName ?? first.storeName, first.contact.accountNumber), c.ref] : [];
  const link = first.siteUrl ? `${first.siteUrl}/trade` : null;
  const showList = invoices.length > 1 || stage === 'manual';
  const text = [
    c.hello(first.customerName), '', c.lead(stage, o), '',
    ...(showList ? [c.invoices, ...invoices.map((i) => c.line(i.orderNo, fmt(i), i.dueOn)), ''] : []),
    ...bank, ...(bank.length ? [''] : []), ...(link ? [`${c.view}: ${link}`, ''] : []), c.thanks, first.storeName,
  ].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;color:#1d1b19"><h2 style="font-family:Georgia,serif">${esc(first.storeName)}</h2>
<p>${esc(c.hello(first.customerName))}</p><p>${esc(c.lead(stage, o))}</p>
${showList ? `<p>${esc(c.invoices)}</p><ul>${invoices.map((i) => `<li>${esc(i.orderNo)}: ${esc(fmt(i))}, ${esc(i.dueOn)}</li>`).join('')}</ul>` : ''}
${bank.map((b) => `<p style="background:#f3e6c8;padding:12px;border-radius:8px">${esc(b)}</p>`).join('')}
${link ? `<p><a href="${esc(link)}">${esc(c.view)}</a></p>` : ''}<p>${esc(c.thanks)}</p></div>`;
  return { to: first.email, subject: c.subject(stage, first.orderNo), text, html };
}

export interface CollectionsResult { reminders: number; holds: number; releases: number }

/**
 * The daily round, safe to run any number of times: each invoice gets each automatic reminder once; a business more than
 * its hold limit overdue is put on hold and told; a business held by this rule is released once it has paid up.
 * Without a mailer nothing is sent (and nothing is recorded as sent), but holds and releases still happen.
 */
export async function runCollections(db: Db, mailer: Mailer | undefined, now = new Date(), only: { organizationId?: string } = {}): Promise<CollectionsResult> {
  const today = now.toISOString().slice(0, 10);
  const invoices = await openInvoices(db, today, only);
  const result: CollectionsResult = { reminders: 0, holds: 0, releases: 0 };

  // 1. Reminders: the most advanced stage each invoice has reached, if it has not been sent yet.
  for (const inv of invoices) {
    const stage = stageFor(inv.daysOverdue);
    if (!stage || !mailer || !inv.email || inv.tradeStatus !== 'approved') continue;
    const mail = renderReminder(stage, [inv]);
    const sent = await withTx(db, async (tx) => {
      const first = await tx.query('INSERT INTO dunning_notices (order_id, stage, sent_to) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [inv.orderId, stage, inv.email]);
      if (!first.rowCount) return false;
      await mailer.send(mail);   // if this throws, the record rolls back and the reminder is tried again on the next round
      return true;
    }).catch((err: Error) => { console.error('payment reminder failed', inv.orderNo, err.message); return false; });
    if (sent) result.reminders++;
  }

  // 2. Holds and releases, per business.
  const byAccount = new Map<string, Invoice[]>();
  for (const inv of invoices) byAccount.set(inv.tradeId, [...(byAccount.get(inv.tradeId) ?? []), inv]);
  const heldNow = await db.query<{ id: string; organization_id: string }>(`SELECT id, organization_id FROM trade_accounts WHERE status = 'suspended' AND held_automatically AND ($1::uuid IS NULL OR organization_id = $1)`, [only.organizationId ?? null]);
  for (const h of heldNow.rows) if (!byAccount.has(h.id)) byAccount.set(h.id, []);   // nothing owing at all: certainly releasable
  for (const [tradeId, list] of byAccount) {
    const account = list[0];
    const worst = list.reduce<Invoice | null>((w, i) => (!w || i.daysOverdue > w.daysOverdue ? i : w), null);
    if (account && account.tradeStatus === 'approved' && account.holdAfterDays > 0 && worst && worst.daysOverdue >= account.holdAfterDays) {
      const changed = await withTx(db, async (tx) => {
        const u = await tx.query(
          `UPDATE trade_accounts SET status = 'suspended', held_automatically = true, note = $2 WHERE id = $1 AND status = 'approved'`,
          [tradeId, `On hold automatically: ${worst.orderNo} is ${worst.daysOverdue} days overdue`],
        );
        if (!u.rowCount) return false;
        await writeAudit(tx, { organizationId: worst.organizationId, actorUserId: null, action: 'trade.auto_hold', entityType: 'trade_account', entityId: tradeId, after: { orderNo: worst.orderNo, daysOverdue: worst.daysOverdue } });
        return true;
      });
      if (changed) {
        result.holds++;
        if (mailer && worst.email) {
          await withTx(db, async (tx) => {
            const first = await tx.query(`INSERT INTO dunning_notices (order_id, stage, sent_to) VALUES ($1, 'hold', $2) ON CONFLICT DO NOTHING`, [worst.orderId, worst.email]);
            if (first.rowCount) await mailer.send(renderReminder('hold', [worst], account.holdAfterDays));
          }).catch((err: Error) => console.error('hold notice failed', worst.orderNo, err.message));
        }
      }
      continue;
    }
    // Release a business held by this rule once nothing is overdue by its limit any more.
    const stillOverLimit = list.some((i) => i.holdAfterDays > 0 && i.daysOverdue >= i.holdAfterDays);
    if (!stillOverLimit) {
      const orgId = account?.organizationId ?? heldNow.rows.find((h) => h.id === tradeId)?.organization_id;
      const released = await withTx(db, async (tx) => {
        const u = await tx.query(`UPDATE trade_accounts SET status = 'approved', held_automatically = false, note = NULL WHERE id = $1 AND status = 'suspended' AND held_automatically`, [tradeId]);
        if (!u.rowCount) return false;
        await writeAudit(tx, { organizationId: orgId!, actorUserId: null, action: 'trade.auto_release', entityType: 'trade_account', entityId: tradeId });
        return true;
      });
      if (released) result.releases++;
    }
  }
  return result;
}

/** A person's reminder: everything the business owes, in one email. Once a day per business at most. */
export async function sendManualReminder(db: Db, mailer: Mailer | undefined, tradeId: string, organizationId: string, userId: string, now = new Date()): Promise<{ sentTo: string; invoices: number }> {
  const invoices = await openInvoices(db, now.toISOString().slice(0, 10), { organizationId, tradeId });
  if (!invoices.length) {
    const exists = await db.query('SELECT 1 FROM trade_accounts WHERE id = $1 AND organization_id = $2', [tradeId, organizationId]);
    if (!exists.rowCount) throw notFound('Trade account');
    throw conflict('Nothing is owing on this account');
  }
  if (!mailer) throw conflict('Email is not set up, so no reminder can be sent');
  const target = invoices.reduce((w, i) => (i.daysOverdue > w.daysOverdue ? i : w), invoices[0]!);
  await withTx(db, async (tx) => {
    const recent = await tx.query(`SELECT 1 FROM dunning_notices n JOIN sales_orders o ON o.id = n.order_id JOIN trade_accounts t ON t.customer_id = o.customer_id AND t.storefront_id = o.storefront_id
                                    WHERE t.id = $1 AND n.stage = 'manual' AND n.sent_at > $2::timestamptz - interval '24 hours'`, [tradeId, now]);
    if (recent.rowCount) throw conflict('A reminder was already sent to this business in the last 24 hours');
    await tx.query(`INSERT INTO dunning_notices (order_id, stage, sent_to, sent_by, sent_at) VALUES ($1, 'manual', $2, $3, $4)`, [target.orderId, target.email, userId, now]);
    await mailer.send(renderReminder('manual', invoices));
    await writeAudit(tx, { organizationId, actorUserId: userId, action: 'trade.reminder', entityType: 'trade_account', entityId: tradeId, after: { invoices: invoices.length } });
  });
  return { sentTo: target.email, invoices: invoices.length };
}
