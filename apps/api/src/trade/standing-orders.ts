import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { withTx, type Db } from '../db.js';
import { AppError, conflict, invalid, notFound } from '../errors.js';
import type { Mailer } from '../notify/mailer.js';
import { loadLiveStorefront } from '../shop/catalog.js';
import { shopMessage, hasMessage } from '../shop/messages.js';
import { approvedTrade, placeOrder } from '../shop/orders.js';
import type { ShopLanguage } from '../shop/translations.js';

export const FREQUENCIES = ['weekly', 'fortnightly', 'monthly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const MAX_ACTIVE_PER_CUSTOMER = 10;
export const FAILURES_BEFORE_PAUSE = 3;

export const createBody = z.object({
  fromOrderNo: z.string().regex(/^[A-Z]{2,5}-\d{6,}$/),
  addressId: z.string().uuid(),
  frequency: z.enum(FREQUENCIES),
  firstRunOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentMethod: z.enum(['account', 'bank_transfer']).default('account'),
}).strict();

const DAY = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The date after `from` on this schedule. Monthly keeps the day of the month (schedules start on the 1st to 28th). */
export function nextOccurrence(from: string, frequency: Frequency): string {
  if (frequency === 'weekly') return iso(utc(from) + 7 * DAY);
  if (frequency === 'fortnightly') return iso(utc(from) + 14 * DAY);
  const d = new Date(utc(from));
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
}

/** The first date on the schedule that is after `today`: a missed day runs once, never a burst of catch-up orders. */
export function nextAfter(from: string, today: string, frequency: Frequency): string {
  let next = nextOccurrence(from, frequency);
  while (next <= today) next = nextOccurrence(next, frequency);
  return next;
}

export async function readStandingOrders(db: Pick<Db, 'query'>, where: { organizationId: string; customerId?: string; id?: string; status?: string }) {
  const { rows } = await db.query(
    `SELECT so.id, so.status, so.frequency, so.payment_method AS "paymentMethod", to_char(so.next_run_on, 'YYYY-MM-DD') AS "nextRunOn", so.source_order_no AS "sourceOrderNo",
            so.failures_in_row AS "failuresInRow", so.paused_reason AS "pausedReason", so.created_at AS "createdAt", so.legal_entity_id AS "legalEntityId",
            t.business_name AS "businessName", c.full_name AS "contactName", c.email, a.label AS "addressLabel", a.line1 || ', ' || a.city AS "addressText",
            (SELECT json_build_object('runOn', to_char(r.run_on, 'YYYY-MM-DD'), 'outcome', r.outcome, 'reason', r.reason, 'orderNo', (SELECT order_no FROM sales_orders WHERE id = r.order_id))
               FROM standing_order_runs r WHERE r.standing_order_id = so.id ORDER BY r.run_on DESC LIMIT 1) AS "lastRun",
            COALESCE((SELECT json_agg(json_build_object('variantId', l.variant_id, 'sku', v.sku, 'title', COALESCE(sp.title, p.name), 'quantity', l.quantity) ORDER BY v.sku)
                        FROM standing_order_lines l JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
                        LEFT JOIN storefront_products sp ON sp.product_id = p.id AND sp.storefront_id = so.storefront_id WHERE l.standing_order_id = so.id), '[]'::json) AS lines
       FROM (SELECT so.*, s.legal_entity_id FROM standing_orders so JOIN storefronts s ON s.id = so.storefront_id) so
       JOIN trade_accounts t ON t.id = so.trade_account_id JOIN customers c ON c.id = so.customer_id JOIN customer_addresses a ON a.id = so.address_id
      WHERE so.organization_id = $1 AND ($2::uuid IS NULL OR so.customer_id = $2) AND ($3::uuid IS NULL OR so.id = $3) AND ($4::text IS NULL OR so.status = $4)
      ORDER BY so.next_run_on, so.created_at`,
    [where.organizationId, where.customerId ?? null, where.id ?? null, where.status ?? null],
  );
  return rows.map((r) => ({ ...r, lines: (r.lines as { quantity: string }[]).map((l) => ({ ...l, quantity: String(Number(l.quantity)) })) }));
}

/** Creates a standing order from an earlier order of the buyer's: same goods, a schedule, a saved address. */
export async function createStandingOrder(db: Db, sfId: string, organizationId: string, customerId: string, input: z.infer<typeof createBody>, requestId?: string) {
  const today = new Date().toISOString().slice(0, 10);
  if (input.firstRunOn < today) throw invalid('The first order cannot be in the past');
  if (utc(input.firstRunOn) > utc(today) + 400 * DAY) throw invalid('The first order must be within the next year');
  if (input.frequency === 'monthly' && Number(input.firstRunOn.slice(8, 10)) > 28) throw invalid('A monthly schedule must start on a day from the 1st to the 28th');
  return withTx(db, async (tx) => {
    const trade = await tx.query<{ id: string; status: string }>('SELECT id, status FROM trade_accounts WHERE storefront_id = $1 AND customer_id = $2 FOR UPDATE', [sfId, customerId]);
    if (trade.rows[0]?.status !== 'approved') throw conflict('Standing orders are for businesses with an approved trade account', { key: 'err.standing.hold' });
    const addr = await tx.query('SELECT 1 FROM customer_addresses WHERE id = $1 AND customer_id = $2', [input.addressId, customerId]);
    if (!addr.rowCount) throw invalid('Choose one of your saved delivery addresses', { key: 'err.address.choose' });
    const lines = await tx.query<{ variant_id: string; quantity: string }>(
      `SELECT l.variant_id, l.quantity FROM sales_order_lines l JOIN sales_orders o ON o.id = l.order_id
        WHERE o.order_no = $1 AND o.customer_id = $2 AND o.storefront_id = $3 AND o.status NOT IN ('cancelled', 'expired')`,
      [input.fromOrderNo, customerId, sfId],
    );
    if (!lines.rowCount) throw notFound('Order');
    const active = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM standing_orders WHERE customer_id = $1 AND status <> 'cancelled'`, [customerId]);
    if (active.rows[0]!.n >= MAX_ACTIVE_PER_CUSTOMER) throw conflict(`You can have up to ${MAX_ACTIVE_PER_CUSTOMER} standing orders`, { key: 'err.standing.max', vars: { n: MAX_ACTIVE_PER_CUSTOMER } });
    const created = await tx.query<{ id: string }>(
      `INSERT INTO standing_orders (organization_id, storefront_id, trade_account_id, customer_id, address_id, payment_method, frequency, next_run_on, source_order_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [organizationId, sfId, trade.rows[0]!.id, customerId, input.addressId, input.paymentMethod, input.frequency, input.firstRunOn, input.fromOrderNo],
    );
    const id = created.rows[0]!.id;
    for (const l of lines.rows) await tx.query('INSERT INTO standing_order_lines (standing_order_id, variant_id, quantity) VALUES ($1,$2,$3)', [id, l.variant_id, l.quantity]);
    await writeAudit(tx, { organizationId, actorUserId: null, requestId, action: 'standing_order.create', entityType: 'standing_order', entityId: id, after: { by: 'customer', customerId, frequency: input.frequency, firstRunOn: input.firstRunOn, fromOrderNo: input.fromOrderNo } });
    return id;
  });
}

type Change = 'pause' | 'resume' | 'cancel';

/** Pause, resume or cancel — by the buyer (customerId given) or by staff. Resuming never runs a missed day: it picks up from the next one. */
export async function changeStandingOrder(db: Db, organizationId: string, id: string, change: Change, by: { customerId?: string; userId?: string }, requestId?: string) {
  await withTx(db, async (tx) => {
    const found = await tx.query<{ status: string; frequency: Frequency; next_run_on: string }>(
      `SELECT status, frequency, to_char(next_run_on, 'YYYY-MM-DD') AS next_run_on FROM standing_orders WHERE id = $1 AND organization_id = $2 AND ($3::uuid IS NULL OR customer_id = $3) FOR UPDATE`,
      [id, organizationId, by.customerId ?? null],
    );
    const so = found.rows[0];
    if (!so) throw notFound('Standing order');
    if (so.status === 'cancelled') throw conflict('This standing order is cancelled', { key: 'err.standing.cancelled' });
    const today = new Date().toISOString().slice(0, 10);
    if (change === 'pause') {
      if (so.status === 'paused') return;
      await tx.query(`UPDATE standing_orders SET status = 'paused', paused_reason = $2 WHERE id = $1`, [id, by.customerId ? 'Paused by the buyer' : 'Paused by staff']);
    } else if (change === 'resume') {
      if (so.status === 'active') return;
      const next = so.next_run_on > today ? so.next_run_on : nextAfter(so.next_run_on, today, so.frequency);
      await tx.query(`UPDATE standing_orders SET status = 'active', paused_reason = NULL, failures_in_row = 0, next_run_on = $2 WHERE id = $1`, [id, next]);
    } else {
      await tx.query(`UPDATE standing_orders SET status = 'cancelled' WHERE id = $1`, [id]);
    }
    await writeAudit(tx, { organizationId, actorUserId: by.userId ?? null, requestId, action: `standing_order.${change}`, entityType: 'standing_order', entityId: id, after: { by: by.customerId ? 'customer' : 'staff' } });
  });
}

// ---- the daily run

const WORDS: Record<ShopLanguage, { freq: Record<Frequency, string>; hello(n: string): string; subject: string; failed(freq: string, date: string, reason: string, next: string): string; paused: string; view: string; thanks: string }> = {
  en: {
    freq: { weekly: 'weekly', fortnightly: 'fortnightly', monthly: 'monthly' }, hello: (n) => `Hello ${n},`, subject: 'Your standing order could not be placed',
    failed: (f, d, r, n) => `Your ${f} standing order due on ${d} could not be placed: ${r}. We will try again on ${n}.`,
    paused: 'After several failed attempts it has been paused. You can resume it from your trade account page once the problem is sorted out.', view: 'See your standing orders', thanks: 'Thank you for trading with us.',
  },
  fr: {
    freq: { weekly: 'hebdomadaire', fortnightly: 'tous les 15 jours', monthly: 'mensuelle' }, hello: (n) => `Bonjour ${n},`, subject: 'Votre commande permanente n’a pas pu être passée',
    failed: (f, d, r, n) => `Votre commande permanente (${f}) prévue le ${d} n’a pas pu être passée : ${r}. Nous réessaierons le ${n}.`,
    paused: 'Après plusieurs échecs, elle a été suspendue. Vous pourrez la reprendre depuis votre compte professionnel une fois le problème réglé.', view: 'Voir vos commandes permanentes', thanks: 'Merci de votre confiance.',
  },
  ha: {
    freq: { weekly: 'na mako-mako', fortnightly: 'na kowane mako biyu', monthly: 'na kowane wata' }, hello: (n) => `Sannu ${n},`, subject: 'Ba a iya yin odarku ta dindindin ba',
    failed: (f, d, r, n) => `Ba a iya yin odarku ta dindindin (${f}) da za a yi ranar ${d} ba: ${r}. Za mu sake gwadawa ranar ${n}.`,
    paused: 'Bayan gazawa sau da dama, an dakatar da ita. Kuna iya sake kunna ta daga shafin asusun ɗan kasuwanku bayan an gyara matsalar.', view: 'Duba odojinku na dindindin', thanks: 'Mun gode da yin kasuwanci da mu.',
  },
};

export interface StandingRunResult { placed: number; failed: number; paused: number }

/**
 * Places every standing order that has come due, once. Each run uses a key made from the order and the date, so running
 * this twice (or two servers at once) places one order. A failure is recorded and the buyer is told; after three in a row
 * the standing order pauses itself.
 */
export async function runStandingOrders(db: Db, mailer: Mailer | undefined, now = new Date(), only: { organizationId?: string } = {}): Promise<StandingRunResult> {
  const today = now.toISOString().slice(0, 10);
  const due = await db.query<{ id: string; organization_id: string; customer_id: string; address_id: string; payment_method: 'account' | 'bank_transfer'; frequency: Frequency; run_on: string; failures: number; slug: string; email: string; full_name: string; language: ShopLanguage }>(
    `SELECT so.id, so.organization_id, so.customer_id, so.address_id, so.payment_method, so.frequency, to_char(so.next_run_on, 'YYYY-MM-DD') AS run_on, so.failures_in_row AS failures,
            s.slug, c.email, c.full_name, c.language
       FROM standing_orders so JOIN storefronts s ON s.id = so.storefront_id JOIN customers c ON c.id = so.customer_id
      WHERE so.status = 'active' AND so.next_run_on <= $1::date AND ($2::uuid IS NULL OR so.organization_id = $2) ORDER BY so.next_run_on, so.created_at`,
    [today, only.organizationId ?? null],
  );
  const result: StandingRunResult = { placed: 0, failed: 0, paused: 0 };
  for (const so of due.rows) {
    let sf;
    try { sf = await loadLiveStorefront(db, so.slug); } catch { continue; }   // a closed store places nothing; it is picked up when it reopens
    const lines = await db.query<{ variant_id: string; quantity: string }>('SELECT variant_id, quantity FROM standing_order_lines WHERE standing_order_id = $1', [so.id]);
    const next = nextAfter(so.run_on, today, so.frequency);
    try {
      const trade = await approvedTrade(db, sf.id, so.customer_id);
      if (!trade) throw new AppError(409, 'conflict', 'Your trade account is on hold, so the standing order was not placed', undefined, { key: 'err.standing.hold' });
      const { order } = await placeOrder(db, sf, so.customer_id, {
        lines: lines.rows.map((l) => ({ variantId: l.variant_id, quantity: String(Number(l.quantity)) })), addressId: so.address_id, paymentMethod: so.payment_method, note: `Standing order (${so.frequency})`,
      }, `standing:${so.id}:${so.run_on}`);
      await withTx(db, async (tx) => {
        await tx.query(`INSERT INTO standing_order_runs (standing_order_id, run_on, outcome, order_id) VALUES ($1,$2,'placed',$3) ON CONFLICT DO NOTHING`, [so.id, so.run_on, (order as { id: string }).id]);
        await tx.query('UPDATE standing_orders SET next_run_on = $2, failures_in_row = 0 WHERE id = $1', [so.id, next]);
      });
      result.placed++;
    } catch (err) {
      if (!(err instanceof AppError)) { console.error('standing order failed unexpectedly', so.id, (err as Error).message); continue; }   // try again next round
      const reason = err.say && hasMessage(err.say.key) ? shopMessage(so.language, err.say.key, err.say.vars) : err.message;
      const failures = so.failures + 1;
      const pause = failures >= FAILURES_BEFORE_PAUSE;
      await withTx(db, async (tx) => {
        await tx.query(`INSERT INTO standing_order_runs (standing_order_id, run_on, outcome, reason) VALUES ($1,$2,'failed',$3) ON CONFLICT DO NOTHING`, [so.id, so.run_on, err.message]);
        await tx.query(
          `UPDATE standing_orders SET next_run_on = $2, failures_in_row = $3, status = CASE WHEN $4 THEN 'paused' ELSE status END, paused_reason = CASE WHEN $4 THEN $5 ELSE paused_reason END WHERE id = $1`,
          [so.id, next, failures, pause, `Paused after ${failures} failed attempts: ${err.message}`],
        );
        await writeAudit(tx, { organizationId: so.organization_id, actorUserId: null, action: 'standing_order.failed', entityType: 'standing_order', entityId: so.id, after: { runOn: so.run_on, reason: err.message, paused: pause } });
      });
      result.failed++;
      if (pause) result.paused++;
      if (mailer && so.email) {
        const w = WORDS[so.language] ?? WORDS.en;
        const text = [w.hello(so.full_name), '', w.failed(w.freq[so.frequency], so.run_on, reason, next), ...(pause ? ['', w.paused] : []), '', w.thanks].join('\n');
        await mailer.send({ to: so.email, subject: w.subject, text, html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto"><p>${esc(w.hello(so.full_name))}</p><p>${esc(w.failed(w.freq[so.frequency], so.run_on, reason, next))}</p>${pause ? `<p>${esc(w.paused)}</p>` : ''}<p>${esc(w.thanks)}</p></div>` })
          .catch((e: Error) => console.error('standing order notice failed', so.id, e.message));
      }
    }
  }
  return result;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
