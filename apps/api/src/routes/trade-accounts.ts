import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, grantsFor } from '../auth/authorize.js';
import { withTx, type Db } from '../db.js';
import { invalid, notFound } from '../errors.js';
import { audit, uuid } from '../inventory/common.js';

const decisionBody = z.object({
  status: z.enum(['approved', 'rejected', 'suspended']),
  priceListId: uuid.optional(),
  creditLimitMinor: z.number().int().min(0).max(1_000_000_000_000).optional(),
  paymentTermsDays: z.number().int().min(0).max(180).optional(),
  note: z.string().trim().max(500).optional(),
});

/** Wholesale applications and the terms each approved business trades on. */
export const tradeAccountRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/trade-accounts', async (req) => {
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'suspended']).optional() }).parse(req.query);
    const grants = await grantsFor(db, req.actor, 'trade.manage');
    const { rows } = await db.query(
      `SELECT t.id, t.business_name AS "businessName", t.tax_id AS "taxId", t.status, t.price_list_id AS "priceListId", t.credit_limit_minor AS "creditLimitMinor",
              t.payment_terms_days AS "paymentTermsDays", t.note, t.created_at AS "createdAt", s.name AS "storeName", s.currency, s.legal_entity_id AS "legalEntityId",
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
                payment_terms_days = COALESCE($5, payment_terms_days), note = COALESCE($6, note), reviewed_by = $7, reviewed_at = now() WHERE id = $1`,
        [id, body.status, listId, body.creditLimitMinor ?? null, body.paymentTermsDays ?? null, body.note ?? null, actor.userId],
      );
      await audit(tx, req, `trade.${body.status}`, 'trade_account', id, body);
      return { id, status: body.status };
    });
  });
};
