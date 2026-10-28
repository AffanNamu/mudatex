import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize } from '../auth/authorize.js';
import { withTx, type Db } from '../db.js';
import { invalid, notFound } from '../errors.js';
import { audit, uuid } from '../inventory/common.js';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The customer desk: look up a shopper, see what they have bought, block or unblock their account, and give them a copy of what
 * is held about them. Shoppers' personal details are for people who hold the whole-company permission, not for a single shop.
 */
export const customerRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  const need = (req: { actor: import('../auth/authorize.js').Actor }, tx: Pick<Db, 'query'> = db) => authorize(tx as never, req.actor, 'customers.manage', { kind: 'organization' });

  app.get('/customers', async (req) => {
    const q = z.object({
      q: z.string().trim().min(1).max(80).optional(),
      status: z.enum(['active', 'blocked']).optional(),
      page: z.coerce.number().int().min(1).max(1000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }).parse(req.query);
    await need(req);
    const params: unknown[] = [req.actor.organizationId];
    const where = ['c.organization_id = $1'];
    if (q.status) where.push(`c.status = $${params.push(q.status)}`);
    if (q.q) {
      const like = `$${params.push(`%${escapeLike(q.q)}%`)}`;
      where.push(`(c.full_name ILIKE ${like} OR c.email ILIKE ${like} OR c.phone ILIKE ${like})`);
    }
    const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM customers c WHERE ${where.join(' AND ')}`, params)).rows[0]!.n);
    const { rows } = await db.query(
      `SELECT c.id, c.full_name AS "fullName", c.email, c.phone, c.status, c.created_at AS "createdAt",
              (SELECT count(*)::int FROM sales_orders o WHERE o.customer_id = c.id) AS "orders",
              (SELECT max(o.placed_at) FROM sales_orders o WHERE o.customer_id = c.id) AS "lastOrderAt",
              EXISTS (SELECT 1 FROM trade_accounts t WHERE t.customer_id = c.id AND t.status = 'approved') AS "isTrade"
         FROM customers c WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT $${params.push(q.limit)} OFFSET $${params.push((q.page - 1) * q.limit)}`, params);
    return { page: q.page, limit: q.limit, total, items: rows };
  });

  async function detail(id: string, organizationId: string) {
    const c = await db.query(
      `SELECT id, full_name AS "fullName", email, phone, status, marketing_opt_in AS "marketingOptIn", sms_opt_in AS "smsOptIn", language,
              blocked_reason AS "blockedReason", blocked_at AS "blockedAt", created_at AS "createdAt"
         FROM customers WHERE id = $1 AND organization_id = $2`, [id, organizationId]);
    if (!c.rows[0]) throw notFound('Customer');
    const addresses = await db.query(`SELECT label, recipient, phone, line1, line2, city, state, country_code AS "countryCode", is_default AS "isDefault" FROM customer_addresses WHERE customer_id = $1 ORDER BY is_default DESC, created_at`, [id]);
    const orders = await db.query(
      `SELECT o.id, o.order_no AS "orderNo", o.status, o.currency, o.total_minor::float8 AS "totalMinor", o.paid_minor::float8 AS "paidMinor", o.payment_method AS "paymentMethod", o.placed_at AS "placedAt", cu.minor_unit AS "minorUnit"
         FROM sales_orders o JOIN currencies cu ON cu.code = o.currency WHERE o.customer_id = $1 ORDER BY o.placed_at DESC LIMIT 100`, [id]);
    const trade = await db.query(`SELECT business_name AS "businessName", tax_id AS "taxId", status, credit_limit_minor::float8 AS "creditLimitMinor", payment_terms_days AS "paymentTermsDays" FROM trade_accounts WHERE customer_id = $1`, [id]);
    const reviews = await db.query(`SELECT count(*)::int AS n FROM product_reviews WHERE customer_id = $1`, [id]);
    return { ...c.rows[0], addresses: addresses.rows, orders: orders.rows, tradeAccounts: trade.rows, reviews: reviews.rows[0].n };
  }

  app.get('/customers/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await need(req);
    return detail(id, req.actor.organizationId);
  });

  /** Everything held about the customer, for them to be given on request. */
  app.get('/customers/:id/export', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await need(req);
    const d = await detail(id, req.actor.organizationId);
    await withTx(db, (tx) => audit(tx, req, 'customer.export', 'customer', id));
    return reply.header('content-disposition', `attachment; filename="customer-${id}.json"`).send({ exportedAt: new Date().toISOString(), ...d });
  });

  for (const [name, status] of [['block', 'blocked'], ['unblock', 'active']] as const) {
    app.post(`/customers/:id/${name}`, async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const body = z.object({ reason: z.string().trim().min(3).max(500).optional() }).parse(req.body ?? {});
      await need(req);
      if (status === 'blocked' && !body.reason) throw invalid('Say why the account is blocked');
      await withTx(db, async (tx) => {
        const r = await tx.query(
          `UPDATE customers SET status = $3, blocked_reason = CASE WHEN $3 = 'blocked' THEN $4 ELSE NULL END, blocked_at = CASE WHEN $3 = 'blocked' THEN now() ELSE NULL END
            WHERE id = $1 AND organization_id = $2`, [id, req.actor.organizationId, status, body.reason ?? null]);
        if (!r.rowCount) throw notFound('Customer');
        await audit(tx, req, `customer.${name}`, 'customer', id, { reason: body.reason });
      });
      return detail(id, req.actor.organizationId);
    });
  }
};
