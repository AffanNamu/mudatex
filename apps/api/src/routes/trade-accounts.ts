import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, grantsFor } from '../auth/authorize.js';
import { withTx, type Db } from '../db.js';
import { invalid, notFound } from '../errors.js';
import type { Mailer } from '../notify/mailer.js';
import { openInvoices, sendManualReminder } from '../trade/collections.js';
import { changeStandingOrder, readStandingOrders } from '../trade/standing-orders.js';
import { audit, uuid } from '../inventory/common.js';

const decisionBody = z.object({
  status: z.enum(['approved', 'rejected', 'suspended']),
  priceListId: uuid.optional(),
  creditLimitMinor: z.number().int().min(0).max(1_000_000_000_000).optional(),
  paymentTermsDays: z.number().int().min(0).max(180).optional(),
  note: z.string().trim().max(500).optional(),
  /** Days overdue after which the business is put on hold automatically; 0 turns the automatic hold off. */
  holdAfterDays: z.number().int().min(0).max(365).optional(),
});

/** Wholesale applications and the terms each approved business trades on. */
export const tradeAccountRoutes: FastifyPluginAsync<{ db: Db; mailer?: Mailer }> = async (app, { db, mailer }) => {
  app.get('/trade-accounts', async (req) => {
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'suspended']).optional() }).parse(req.query);
    const grants = await grantsFor(db, req.actor, 'trade.manage');
    const { rows } = await db.query(
      `SELECT t.id, t.business_name AS "businessName", t.tax_id AS "taxId", t.status, t.price_list_id AS "priceListId", t.credit_limit_minor AS "creditLimitMinor",
              t.payment_terms_days AS "paymentTermsDays", t.hold_after_days AS "holdAfterDays", t.held_automatically AS "heldAutomatically", t.note, t.created_at AS "createdAt", s.name AS "storeName", s.currency, s.legal_entity_id AS "legalEntityId",
              e.country_code AS "countryCode", c.full_name AS "contactName", c.email, c.phone,
              (SELECT COALESCE(sum(o.total_minor - o.paid_minor), 0) FROM sales_orders o WHERE o.customer_id = t.customer_id AND o.payment_method = 'account'
                  AND o.status NOT IN ('cancelled', 'expired')) AS "creditUsedMinor"
         FROM trade_accounts t JOIN storefronts s ON s.id = t.storefront_id JOIN legal_entities e ON e.id = s.legal_entity_id JOIN customers c ON c.id = t.customer_id
        WHERE t.organization_id = $1 AND ($2::text IS NULL OR t.status = $2) ORDER BY t.created_at DESC LIMIT 200`,
      [req.actor.organizationId, q.status ?? null],
    );
    return rows
      .filter((r) => grants.group || grants.countries.has(r.countryCode.trim()) || grants.legalEntities.has(r.legalEntityId))
      .map(({ countryCode: _c, legalEntityId: _l, ...r }) => ({ ...r, creditLimitMinor: Number(r.creditLimitMinor), creditUsedMinor: Number(r.creditUsedMinor) }));
  });

  app.post('/trade-accounts/:id/decision', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = decisionBody.parse(req.body);
    const { actor } = req;
    return withTx(db, async (tx) => {
      const found = await tx.query<{ legal_entity_id: string; currency: string; customer_id: string; price_list_id: string | null }>(
        `SELECT s.legal_entity_id, s.currency, t.customer_id, t.price_list_id FROM trade_accounts t JOIN storefronts s ON s.id = t.storefront_id
          WHERE t.id = $1 AND t.organization_id = $2 FOR UPDATE OF t`,
        [id, actor.organizationId],
      );
      const row = found.rows[0];
      if (!row) throw notFound('Trade account');
      await authorize(tx, actor, 'trade.manage', { kind: 'legal_entity', legalEntityId: row.legal_entity_id });
      const listId = body.priceListId ?? row.price_list_id;
      if (body.status === 'approved') {
        if (!listId) throw invalid('Choose the trade price list this business buys from');
        const list = await tx.query('SELECT 1 FROM price_lists WHERE id = $1 AND legal_entity_id = $2 AND currency = $3', [listId, row.legal_entity_id, row.currency]);
        if (!list.rowCount) throw invalid('The price list must belong to the store\'s company and use the store\'s currency');
      }
      await tx.query(
        `UPDATE trade_accounts SET status = $2, price_list_id = $3, credit_limit_minor = COALESCE($4, credit_limit_minor),
                payment_terms_days = COALESCE($5, payment_terms_days), note = COALESCE($6, note), hold_after_days = COALESCE($8, hold_after_days),
                held_automatically = false, reviewed_by = $7, reviewed_at = now() WHERE id = $1`,
        [id, body.status, listId, body.creditLimitMinor ?? null, body.paymentTermsDays ?? null, body.note ?? null, actor.userId, body.holdAfterDays ?? null],
      );
      await audit(tx, req, `trade.${body.status}`, 'trade_account', id, body);
      return { id, status: body.status };
    });
  });

  /** Who owes what: every unpaid order on account, grouped by business, with how late each is and how long the worst has been. */
  app.get('/collections', async (req) => {
    const grants = await grantsFor(db, req.actor, 'trade.manage');
    const today = new Date().toISOString().slice(0, 10);
    const visible = (await openInvoices(db, today, { organizationId: req.actor.organizationId }))
      .filter((i) => grants.group || grants.countries.has(i.countryCode.trim()) || grants.legalEntities.has(i.legalEntityId));
    const accounts = new Map<string, any>();
    const totals: Record<string, { currency: string; minorUnit: number; outstandingMinor: number; overdueMinor: number; buckets: { current: number; d1_30: number; d31_60: number; d61plus: number } }> = {};
    for (const i of visible) {
      const a = accounts.get(i.tradeId) ?? { id: i.tradeId, businessName: i.businessName, contactName: i.customerName, email: i.email, status: i.tradeStatus, heldAutomatically: i.heldAutomatically, holdAfterDays: i.holdAfterDays, currency: i.currency, minorUnit: i.minorUnit, outstandingMinor: 0, overdueMinor: 0, oldestOverdueDays: 0, invoices: [] as unknown[] };
      a.outstandingMinor += i.outstandingMinor;
      if (i.daysOverdue >= 1) { a.overdueMinor += i.outstandingMinor; a.oldestOverdueDays = Math.max(a.oldestOverdueDays, i.daysOverdue); }
      a.invoices.push({ orderId: i.orderId, orderNo: i.orderNo, dueOn: i.dueOn, outstandingMinor: i.outstandingMinor, totalMinor: i.totalMinor, daysOverdue: i.daysOverdue, lastNotice: i.lastNotice });
      accounts.set(i.tradeId, a);
      const t = (totals[i.currency] ??= { currency: i.currency, minorUnit: i.minorUnit, outstandingMinor: 0, overdueMinor: 0, buckets: { current: 0, d1_30: 0, d31_60: 0, d61plus: 0 } });
      t.outstandingMinor += i.outstandingMinor;
      if (i.daysOverdue >= 1) t.overdueMinor += i.outstandingMinor;
      t.buckets[i.daysOverdue < 1 ? 'current' : i.daysOverdue <= 30 ? 'd1_30' : i.daysOverdue <= 60 ? 'd31_60' : 'd61plus'] += i.outstandingMinor;
    }
    // Held businesses first, then the most overdue.
    const list = [...accounts.values()].sort((x, y) => Number(y.status === 'suspended') - Number(x.status === 'suspended') || y.oldestOverdueDays - x.oldestOverdueDays || y.outstandingMinor - x.outstandingMinor);
    return { asOf: today, accounts: list, totals: Object.values(totals) };
  });

  app.post('/trade-accounts/:id/reminder', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    const found = await db.query<{ legal_entity_id: string }>(
      `SELECT s.legal_entity_id FROM trade_accounts t JOIN storefronts s ON s.id = t.storefront_id WHERE t.id = $1 AND t.organization_id = $2`,
      [id, actor.organizationId],
    );
    if (!found.rows[0]) throw notFound('Trade account');
    await authorize(db, actor, 'trade.manage', { kind: 'legal_entity', legalEntityId: found.rows[0].legal_entity_id });
    return sendManualReminder(db, mailer, id, actor.organizationId, actor.userId);
  });

  /** Standing orders across the buyers staff look after. Buyers create their own; staff can pause, resume or cancel them. */
  app.get('/standing-orders', async (req) => {
    const q = z.object({ status: z.enum(['active', 'paused', 'cancelled']).optional() }).parse(req.query);
    const grants = await grantsFor(db, req.actor, 'trade.manage');
    const rows = await readStandingOrders(db, { organizationId: req.actor.organizationId, status: q.status });
    const countries = await db.query<{ id: string; country_code: string }>('SELECT id, country_code FROM legal_entities WHERE organization_id = $1', [req.actor.organizationId]);
    const country = new Map(countries.rows.map((c) => [c.id, c.country_code.trim()]));
    return rows.filter((r) => grants.group || grants.legalEntities.has(r.legalEntityId) || grants.countries.has(country.get(r.legalEntityId) ?? '')).map(({ legalEntityId: _l, ...r }) => r);
  });

  for (const change of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/standing-orders/:id/${change}`, async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const found = await db.query<{ legal_entity_id: string }>(
        `SELECT s.legal_entity_id FROM standing_orders so JOIN storefronts s ON s.id = so.storefront_id WHERE so.id = $1 AND so.organization_id = $2`, [id, req.actor.organizationId]);
      if (!found.rows[0]) throw notFound('Standing order');
      await authorize(db, req.actor, 'trade.manage', { kind: 'legal_entity', legalEntityId: found.rows[0].legal_entity_id });
      await changeStandingOrder(db, req.actor.organizationId, id, change, { userId: req.actor.userId }, req.id);
      const [so] = await readStandingOrders(db, { organizationId: req.actor.organizationId, id });
      const { legalEntityId: _l, ...visible } = so!;
      return visible;
    });
  }
};
