import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TokenVerifier } from '../auth/token.js';
import { writeAudit } from '../audit.js';
import { withTx, type Db } from '../db.js';
import { conflict, forbidden, invalid, notFound, unauthorized } from '../errors.js';
import { cardsFor, loadLiveStorefront, type Storefront } from '../shop/catalog.js';
import { SHOP_LANGUAGES } from '../shop/translations.js';
import { readQuote } from '../trade/quotes.js';
import { orderDocument } from '../shop/documents.js';
import { changeStandingOrder, createBody as standingBody, createStandingOrder, readStandingOrders } from '../trade/standing-orders.js';
import { cancelReturn, requestReturn } from '../shop/returns.js';
import { RETURN_REASONS } from '../shop/returns-read.js';
import { approvedTrade, cancelOrder, creditUsed, MAX_ORDER_LINES, placeOrder, readOrder, tradeStatement } from '../shop/orders.js';
import { AppError } from '../errors.js';
import type { PaymentProvider } from '../payments/paystack.js';
import { settleCardPayment, startCardPayment } from '../shop/card-payments.js';

const slugParam = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,60}$/) });
const uuid = z.string().uuid();
const MAX_ADDRESSES = 10;
const MAX_WISHLIST = 200;

const profileBody = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/).nullable().optional(),
  marketingOptIn: z.boolean().optional(),
  /** Text messages when an order is paid, sent or delivered. */
  smsOptIn: z.boolean().optional(),
  /** The language of the shopper's emails and notifications. */
  language: z.enum(SHOP_LANGUAGES).optional(),
});

const addressBody = z.object({
  label: z.string().trim().min(1).max(40),
  recipient: z.string().trim().min(2).max(120),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/),
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  countryCode: z.string().regex(/^[A-Za-z]{2}$/).transform((c) => c.toUpperCase()),
  isDefault: z.boolean().optional(),
});

const orderBody = z.object({
  lines: z.array(z.object({
    variantId: z.string().uuid(),
    quantity: z.string().regex(/^\d+(\.\d+)?$/, 'Quantity must be a positive decimal string'),
    unitId: z.string().uuid().optional(),
  })).min(1).max(MAX_ORDER_LINES),
  addressId: z.string().uuid(),
  paymentMethod: z.enum(['card', 'bank_transfer', 'account']),
  couponCode: z.string().trim().min(3).max(20).optional(),
  note: z.string().trim().max(500).optional(),
});

const ADDRESS_COLUMNS = `id, label, recipient, phone, line1, line2, city, state, country_code AS "countryCode", is_default AS "isDefault"`;
const CUSTOMER_COLUMNS = `id, email, full_name AS "fullName", phone, marketing_opt_in AS "marketingOptIn", sms_opt_in AS "smsOptIn", language, status, created_at AS "createdAt"`;

declare module 'fastify' {
  interface FastifyRequest {
    shopper: { subject: string; email?: string };
    storefront: Storefront;
  }
}

/**
 * Signed-in shopper endpoints. A shopper is a customer of one organisation (the storefront's), never staff: the same
 * identity provider signs both in, but customers live in their own table and reach only these endpoints.
 */
export const shopCustomerRoutes: FastifyPluginAsync<{ db: Db; verify: TokenVerifier; payments?: PaymentProvider }> = async (app, { db, verify, payments }) => {
  app.decorateRequest('shopper', undefined as never);
  app.decorateRequest('storefront', undefined as never);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    const { slug } = slugParam.parse(req.params);
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    req.shopper = await verify(header.slice('Bearer '.length));
    req.storefront = await loadLiveStorefront(db, slug);
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'private, no-store');
  });

  /** The signed-in customer of this storefront's organisation; blocked customers are refused. */
  async function customer(req: FastifyRequest, db2: Pick<Db, 'query'> = db) {
    const { rows } = await db2.query<{ id: string; status: string }>(
      'SELECT id, status FROM customers WHERE external_subject = $1 AND organization_id = $2',
      [req.shopper.subject, req.storefront.organizationId],
    );
    if (!rows[0]) throw notFound('Customer');
    if (rows[0].status !== 'active') throw forbidden('This account is blocked', { key: 'err.account.blocked' });
    return rows[0].id;
  }

  app.get('/shop/:slug/me', async (req) => {
    const id = await customer(req);
    const { rows } = await db.query(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = $1`, [id]);
    return rows[0];
  });

  // Creating the profile is idempotent: the same signed-in person calling it twice gets the same customer.
  app.post('/shop/:slug/me', async (req, reply) => {
    const body = profileBody.parse(req.body);
    const { subject, email } = req.shopper;
    if (!email) throw invalid('Your sign-in has no email address', { key: 'err.account.noEmail' });
    const { organizationId } = req.storefront;
    const existing = await db.query(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE external_subject = $1 AND organization_id = $2`, [subject, organizationId]);
    if (existing.rows[0]) return existing.rows[0];
    try {
      const { rows } = await db.query(
        `INSERT INTO customers (organization_id, external_subject, email, full_name, phone, marketing_opt_in, sms_opt_in, language)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${CUSTOMER_COLUMNS}`,
        [organizationId, subject, email, body.fullName, body.phone ?? null, body.marketingOptIn ?? false, body.smsOptIn ?? false, body.language ?? 'en'],
      );
      return reply.status(201).send(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('An account with this email already exists', { key: 'err.account.exists' });
      throw err;
    }
  });

  app.put('/shop/:slug/me', async (req) => {
    const body = profileBody.parse(req.body);
    const id = await customer(req);
    const { rows } = await db.query(
      `UPDATE customers SET full_name = $2, phone = COALESCE($3, phone), marketing_opt_in = COALESCE($4, marketing_opt_in), language = COALESCE($5, language), sms_opt_in = COALESCE($6, sms_opt_in)
        WHERE id = $1 RETURNING ${CUSTOMER_COLUMNS}`,
      [id, body.fullName, body.phone ?? null, body.marketingOptIn ?? null, body.language ?? null, body.smsOptIn ?? null],
    );
    return rows[0];
  });

  // Just the language, so the shop can keep it in step with the picker without resending the whole profile.
  app.put('/shop/:slug/me/language', async (req) => {
    const body = z.object({ language: z.enum(SHOP_LANGUAGES) }).parse(req.body);
    const id = await customer(req);
    const { rows } = await db.query(`UPDATE customers SET language = $2 WHERE id = $1 RETURNING ${CUSTOMER_COLUMNS}`, [id, body.language]);
    return rows[0];
  });

  app.get('/shop/:slug/me/addresses', async (req) => {
    const id = await customer(req);
    const { rows } = await db.query(`SELECT ${ADDRESS_COLUMNS} FROM customer_addresses WHERE customer_id = $1 ORDER BY is_default DESC, created_at`, [id]);
    return rows;
  });

  app.post('/shop/:slug/me/addresses', async (req, reply) => {
    const body = addressBody.parse(req.body);
    const created = await withTx(db, async (tx) => {
      const id = await customer(req, tx);
      await tx.query('SELECT 1 FROM customers WHERE id = $1 FOR UPDATE', [id]);
      const count = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM customer_addresses WHERE customer_id = $1', [id]);
      if (count.rows[0]!.n >= MAX_ADDRESSES) throw conflict(`You can save up to ${MAX_ADDRESSES} addresses`, { key: 'err.address.max', vars: { n: MAX_ADDRESSES } });
      // the first address is the default; choosing another default moves it
      const makeDefault = body.isDefault === true || count.rows[0]!.n === 0;
      if (makeDefault) await tx.query('UPDATE customer_addresses SET is_default = false WHERE customer_id = $1', [id]);
      const { rows } = await tx.query(
        `INSERT INTO customer_addresses (customer_id, label, recipient, phone, line1, line2, city, state, country_code, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${ADDRESS_COLUMNS}`,
        [id, body.label, body.recipient, body.phone, body.line1, body.line2 ?? null, body.city, body.state, body.countryCode, makeDefault],
      );
      return rows[0];
    });
    return reply.status(201).send(created);
  });

  app.put('/shop/:slug/me/addresses/:addressId', async (req) => {
    const { addressId } = z.object({ addressId: uuid }).parse(req.params);
    const body = addressBody.parse(req.body);
    return withTx(db, async (tx) => {
      const id = await customer(req, tx);
      await tx.query('SELECT 1 FROM customers WHERE id = $1 FOR UPDATE', [id]);
      const own = await tx.query('SELECT 1 FROM customer_addresses WHERE id = $1 AND customer_id = $2', [addressId, id]);
      if (!own.rowCount) throw notFound('Address');
      if (body.isDefault) await tx.query('UPDATE customer_addresses SET is_default = false WHERE customer_id = $1', [id]);
      const { rows } = await tx.query(
        `UPDATE customer_addresses SET label = $3, recipient = $4, phone = $5, line1 = $6, line2 = $7, city = $8, state = $9,
                country_code = $10, is_default = CASE WHEN $11::boolean IS TRUE THEN true ELSE is_default END
          WHERE id = $1 AND customer_id = $2 RETURNING ${ADDRESS_COLUMNS}`,
        [addressId, id, body.label, body.recipient, body.phone, body.line1, body.line2 ?? null, body.city, body.state, body.countryCode, body.isDefault ?? null],
      );
      return rows[0];
    });
  });

  app.delete('/shop/:slug/me/addresses/:addressId', async (req, reply) => {
    const { addressId } = z.object({ addressId: uuid }).parse(req.params);
    await withTx(db, async (tx) => {
      const id = await customer(req, tx);
      await tx.query('SELECT 1 FROM customers WHERE id = $1 FOR UPDATE', [id]);
      const gone = await tx.query<{ is_default: boolean }>('DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2 RETURNING is_default', [addressId, id]);
      if (!gone.rows[0]) throw notFound('Address');
      if (gone.rows[0].is_default) {
        await tx.query(
          `UPDATE customer_addresses SET is_default = true
            WHERE id = (SELECT id FROM customer_addresses WHERE customer_id = $1 ORDER BY created_at LIMIT 1)`,
          [id],
        );
      }
    });
    return reply.status(204).send();
  });

  app.get('/shop/:slug/me/wishlist', async (req) => {
    const id = await customer(req);
    const { rows } = await db.query(
      `SELECT sp.id, sp.product_id AS "productId", sp.slug, sp.title, sp.brand, sp.images, sp.badges,
              d.slug AS "departmentSlug", d.name AS "departmentName"
         FROM wishlist_items w
         JOIN storefront_products sp ON sp.id = w.storefront_product_id AND sp.published AND sp.storefront_id = $2
         JOIN products p ON p.id = sp.product_id AND p.status = 'active'
         LEFT JOIN storefront_departments d ON d.id = sp.department_id
        WHERE w.customer_id = $1 ORDER BY w.created_at DESC`,
      [id, req.storefront.id],
    );
    return cardsFor(db, req.storefront, rows);
  });

  app.put('/shop/:slug/me/wishlist/:productSlug', async (req, reply) => {
    const { productSlug } = z.object({ productSlug: z.string().regex(/^[a-z0-9-]{1,80}$/) }).parse(req.params);
    await withTx(db, async (tx) => {
      const id = await customer(req, tx);
      const product = await tx.query<{ id: string }>('SELECT id FROM storefront_products WHERE storefront_id = $1 AND slug = $2 AND published', [req.storefront.id, productSlug]);
      if (!product.rows[0]) throw notFound('Product');
      const count = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM wishlist_items WHERE customer_id = $1', [id]);
      if (count.rows[0]!.n >= MAX_WISHLIST) throw conflict('Your wishlist is full', { key: 'err.wishlist.full' });
      await tx.query('INSERT INTO wishlist_items (customer_id, storefront_product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, product.rows[0].id]);
    });
    return reply.status(204).send();
  });

  app.delete('/shop/:slug/me/wishlist/:productSlug', async (req, reply) => {
    const { productSlug } = z.object({ productSlug: z.string().regex(/^[a-z0-9-]{1,80}$/) }).parse(req.params);
    const id = await customer(req);
    await db.query(
      `DELETE FROM wishlist_items WHERE customer_id = $1
          AND storefront_product_id IN (SELECT id FROM storefront_products WHERE storefront_id = $2 AND slug = $3)`,
      [id, req.storefront.id, productSlug],
    );
    return reply.status(204).send();
  });

  // ---- orders. Prices, tax, delivery and stock are all decided here; the client sends only what it wants.
  app.post('/shop/:slug/me/orders', async (req, reply) => {
    const body = orderBody.parse(req.body);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
      throw new AppError(400, 'idempotency_key_required', 'Idempotency-Key header (8-128 characters) is required', undefined, { key: 'err.idempotency' });
    }
    const id = await customer(req);
    const { order, replayed } = await placeOrder(db, req.storefront, id, body, key, req.id);
    if (replayed) reply.header('Idempotent-Replayed', 'true');
    return reply.status(replayed ? 200 : 201).send(order);
  });

  // ---- quotes. Staff agree the prices; accepting places an order at exactly those lines and prices.
  const quoteNoParam = z.object({ quoteNo: z.string().regex(/^[A-Z]{2,5}-\d{6,}$/) });
  const acceptBody = z.object({ addressId: z.string().uuid(), paymentMethod: z.enum(['bank_transfer', 'account']), note: z.string().trim().max(500).optional() }).strict();

  app.get('/shop/:slug/me/quotes', async (req) => {
    const id = await customer(req);
    const { rows } = await db.query(
      `SELECT q.quote_no AS "quoteNo", CASE WHEN q.status = 'sent' AND q.valid_until < CURRENT_DATE THEN 'expired' ELSE q.status END AS status,
              q.currency, (q.subtotal_minor)::float8 AS "totalMinor", to_char(q.valid_until, 'YYYY-MM-DD') AS "validUntil", q.sent_at AS "sentAt",
              (SELECT count(*)::int FROM quote_lines l WHERE l.quote_id = q.id) AS "lineCount"
         FROM quotes q WHERE q.customer_id = $1 AND q.storefront_id = $2 AND q.status <> 'draft' ORDER BY q.created_at DESC LIMIT 100`,
      [id, req.storefront.id],
    );
    return rows;
  });

  app.get('/shop/:slug/me/quotes/:quoteNo', async (req) => {
    const { quoteNo } = quoteNoParam.parse(req.params);
    const id = await customer(req);
    const q = await readQuote(db, { quoteNo, customerId: id, organizationId: req.storefront.organizationId, storefrontId: req.storefront.id });
    if (q.status === 'draft') throw notFound('Quote');
    const { createdBy: _c, tradeAccountId: _t, legalEntityId: _l, customerId: _u, storefrontId: _s, ...visible } = q;
    return visible;
  });

  app.post('/shop/:slug/me/quotes/:quoteNo/accept', async (req, reply) => {
    const { quoteNo } = quoteNoParam.parse(req.params);
    const body = acceptBody.parse(req.body);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
      throw new AppError(400, 'idempotency_key_required', 'Idempotency-Key header (8-128 characters) is required', undefined, { key: 'err.idempotency' });
    }
    const id = await customer(req);
    const { order, replayed } = await placeOrder(db, req.storefront, id, { lines: [], addressId: body.addressId, paymentMethod: body.paymentMethod, note: body.note, quoteNo }, key, req.id);
    if (replayed) reply.header('Idempotent-Replayed', 'true');
    return reply.status(replayed ? 200 : 201).send(order);
  });

  app.post('/shop/:slug/me/quotes/:quoteNo/decline', async (req) => {
    const { quoteNo } = quoteNoParam.parse(req.params);
    const id = await customer(req);
    return withTx(db, async (tx) => {
      const found = await tx.query<{ id: string; status: string }>('SELECT id, status FROM quotes WHERE storefront_id = $1 AND customer_id = $2 AND quote_no = $3 AND status <> \'draft\' FOR UPDATE', [req.storefront.id, id, quoteNo]);
      const q = found.rows[0];
      if (!q) throw notFound('Quote');
      if (q.status !== 'sent') throw conflict('This quote is no longer open', { key: 'err.quote.closed' });
      await tx.query(`UPDATE quotes SET status = 'declined', decided_at = now() WHERE id = $1`, [q.id]);
      await writeAudit(tx, { organizationId: req.storefront.organizationId, actorUserId: null, requestId: req.id, action: 'quote.decline', entityType: 'quote', entityId: q.id, after: { by: 'customer', customerId: id } });
      return readQuote(tx, { id: q.id, organizationId: req.storefront.organizationId }).then(({ createdBy: _c, tradeAccountId: _t, legalEntityId: _l, customerId: _u, storefrontId: _s, ...visible }) => visible);
    });
  });

  // ---- standing orders: the same goods ordered again on a schedule, at that day's trade prices.
  const standingId = z.object({ id: uuid });

  app.get('/shop/:slug/me/standing-orders', async (req) => {
    const id = await customer(req);
    return (await readStandingOrders(db, { organizationId: req.storefront.organizationId, customerId: id })).map(({ legalEntityId: _l, ...s }) => s);
  });

  app.post('/shop/:slug/me/standing-orders', async (req, reply) => {
    const body = standingBody.parse(req.body);
    const id = await customer(req);
    const created = await createStandingOrder(db, req.storefront.id, req.storefront.organizationId, id, body, req.id);
    const [so] = await readStandingOrders(db, { organizationId: req.storefront.organizationId, customerId: id, id: created });
    const { legalEntityId: _l, ...visible } = so!;
    return reply.status(201).send(visible);
  });

  for (const change of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/shop/:slug/me/standing-orders/:id/${change}`, async (req) => {
      const { id: soId } = standingId.parse(req.params);
      const id = await customer(req);
      await changeStandingOrder(db, req.storefront.organizationId, soId, change, { customerId: id }, req.id);
      const [so] = await readStandingOrders(db, { organizationId: req.storefront.organizationId, customerId: id, id: soId });
      const { legalEntityId: _l, ...visible } = so!;
      return visible;
    });
  }

  app.get('/shop/:slug/me/orders', async (req) => {
    const id = await customer(req);
    const { rows } = await db.query(
      `SELECT order_no AS "orderNo", status, currency, total_minor::bigint AS "totalMinor", placed_at AS "placedAt",
              (SELECT count(*)::int FROM sales_order_lines l WHERE l.order_id = o.id) AS "lineCount"
         FROM sales_orders o WHERE customer_id = $1 ORDER BY placed_at DESC LIMIT 100`,
      [id],
    );
    return rows.map((r) => ({ ...r, totalMinor: Number(r.totalMinor) }));
  });

  app.get('/shop/:slug/me/orders/:orderNo', async (req) => {
    const { orderNo } = z.object({ orderNo: z.string().regex(/^[A-Z]{2,5}-\d{6,}$/) }).parse(req.params);
    const id = await customer(req);
    return readOrder(db, { orderNo, customerId: id, organizationId: req.storefront.organizationId });
  });

  /** What is printed on the buyer's invoice or receipt for this order. */
  app.get('/shop/:slug/me/orders/:orderNo/document', async (req) => {
    const { orderNo } = z.object({ orderNo: z.string().regex(/^[A-Z]{2,5}-\d{6,}$/) }).parse(req.params);
    const id = await customer(req);
    const { legalEntityId: _l, ...doc } = await orderDocument(db, { orderNo, customerId: id, organizationId: req.storefront.organizationId });
    return doc;
  });

  app.post('/shop/:slug/me/orders/:orderNo/cancel', async (req) => {
    const { orderNo } = z.object({ orderNo: z.string().regex(/^[A-Z]{2,5}-\d{6,}$/) }).parse(req.params);
    const id = await customer(req);
    return cancelOrder(db, req.storefront.organizationId, { orderNo, customerId: id }, { type: 'customer', id }, 'Cancelled by the customer', req.id);
  });

  // ---- returns. Asked for by the buyer within the store's return window; staff decide.
  const returnBody = z.object({
    reason: z.enum(RETURN_REASONS),
    note: z.string().trim().max(1000).optional(),
    lines: z.array(z.object({ lineNo: z.number().int().min(1).max(MAX_ORDER_LINES), quantity: z.string().regex(/^\d+(\.\d{1,6})?$/) })).min(1).max(MAX_ORDER_LINES),
  });
  app.post('/shop/:slug/me/orders/:orderNo/returns', async (req, reply) => {
    const { orderNo } = z.object({ orderNo: z.string().regex(/^[A-Z]{2,5}-\d{6,}$/) }).parse(req.params);
    const body = returnBody.parse(req.body);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
      throw new AppError(400, 'idempotency_key_required', 'Idempotency-Key header (8-128 characters) is required', undefined, { key: 'err.idempotency' });
    }
    const id = await customer(req);
    const r = await requestReturn(db, req.storefront.organizationId, id, orderNo, body, key, req.id);
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    return reply.status(r.replayed ? 200 : 201).send(await readOrder(db, { orderNo, customerId: id, organizationId: req.storefront.organizationId }));
  });

  app.post('/shop/:slug/me/returns/:id/cancel', async (req) => {
    const { id: returnId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const id = await customer(req);
    await cancelReturn(db, req.storefront.organizationId, id, returnId, req.id);
    return { ok: true };
  });

  // ---- card payment. The amount is the order's; the outcome is whatever the provider confirms to the server.
  const orderNoParam = z.object({ orderNo: z.string().regex(/^[A-Z]{2,5}-\d{6,}$/) });
  const needProvider = () => {
    if (!payments) throw new AppError(503, 'payments_unavailable', 'Card payments are not available right now', undefined, { key: 'err.pay.unavailable' });
    return payments;
  };

  app.post('/shop/:slug/me/orders/:orderNo/pay', async (req) => {
    const { orderNo } = orderNoParam.parse(req.params);
    const provider = needProvider();
    const id = await customer(req);
    return startCardPayment(db, provider, req.storefront, id, orderNo);
  });

  app.post('/shop/:slug/me/orders/:orderNo/payment-check', async (req) => {
    const { orderNo } = orderNoParam.parse(req.params);
    const { reference } = z.object({ reference: z.string().min(8).max(100) }).parse(req.body);
    const provider = needProvider();
    const id = await customer(req);
    const own = await db.query(
      `SELECT 1 FROM payment_attempts a JOIN sales_orders o ON o.id = a.order_id
        WHERE a.reference = $1 AND o.order_no = $2 AND o.customer_id = $3 AND o.organization_id = $4`,
      [reference, orderNo, id, req.storefront.organizationId],
    );
    if (!own.rowCount) throw notFound('Payment');
    const result = await settleCardPayment(db, provider, reference, req.id);
    return { outcome: result.outcome, order: await readOrder(db, { id: result.orderId, customerId: id, organizationId: req.storefront.organizationId }) };
  });

  // ---- reviews: only for products this customer has been sent, once each, and held for a person to approve
  app.post('/shop/:slug/me/reviews', async (req, reply) => {
    const body = z.object({
      productSlug: z.string().regex(/^[a-z0-9-]{1,80}$/),
      rating: z.number().int().min(1).max(5),
      title: z.string().trim().max(100).optional(),
      body: z.string().trim().min(10).max(2000),
    }).parse(req.body);
    const created = await withTx(db, async (tx) => {
      const id = await customer(req, tx);
      const product = await tx.query<{ id: string; product_id: string }>('SELECT id, product_id FROM storefront_products WHERE storefront_id = $1 AND slug = $2 AND published', [req.storefront.id, body.productSlug]);
      if (!product.rows[0]) throw notFound('Product');
      const bought = await tx.query<{ order_id: string }>(
        `SELECT o.id AS order_id FROM sales_orders o JOIN sales_order_lines l ON l.order_id = o.id JOIN product_variants v ON v.id = l.variant_id
          WHERE o.customer_id = $1 AND o.status IN ('shipped', 'delivered') AND v.product_id = $2 ORDER BY o.placed_at DESC LIMIT 1`,
        [id, product.rows[0].product_id],
      );
      if (!bought.rows[0]) throw forbidden('You can review a product once it has been delivered to you', { key: 'err.review.afterDelivery' });
      const who = await tx.query<{ full_name: string }>('SELECT full_name FROM customers WHERE id = $1', [id]);
      const parts = who.rows[0]!.full_name.trim().split(/\s+/);
      const display = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.` : parts[0]!;
      try {
        const { rows } = await tx.query(
          `INSERT INTO product_reviews (organization_id, storefront_product_id, customer_id, order_id, rating, title, body, display_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, rating, title, body, status`,
          [req.storefront.organizationId, product.rows[0].id, id, bought.rows[0].order_id, body.rating, body.title || null, body.body, display],
        );
        return rows[0];
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw conflict('You have already reviewed this product', { key: 'err.review.already' });
        throw err;
      }
    });
    return reply.status(201).send(created);
  });

  // ---- trade (wholesale) account
  const tradeColumns = `id, business_name AS "businessName", tax_id AS "taxId", status, credit_limit_minor AS "creditLimitMinor", payment_terms_days AS "paymentTermsDays", note, created_at AS "createdAt"`;

  app.post('/shop/:slug/me/trade', async (req, reply) => {
    const body = z.object({ businessName: z.string().trim().min(2).max(150), taxId: z.string().trim().max(50).optional() }).parse(req.body);
    const id = await customer(req);
    const existing = await db.query<{ status: string }>('SELECT status FROM trade_accounts WHERE storefront_id = $1 AND customer_id = $2', [req.storefront.id, id]);
    if (existing.rows[0] && existing.rows[0].status !== 'rejected') throw conflict('You already have a trade application or account', { key: 'err.trade.exists' });
    const { rows } = await db.query(
      `INSERT INTO trade_accounts (organization_id, storefront_id, customer_id, business_name, tax_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (storefront_id, customer_id) DO UPDATE SET business_name = $4, tax_id = $5, status = 'pending', note = NULL, reviewed_at = NULL
       RETURNING ${tradeColumns}`,
      [req.storefront.organizationId, req.storefront.id, id, body.businessName, body.taxId ?? null],
    );
    return reply.status(201).send({ ...rows[0], creditLimitMinor: Number(rows[0].creditLimitMinor) });
  });

  app.get('/shop/:slug/me/trade', async (req) => {
    const id = await customer(req);
    const { rows } = await db.query(`SELECT ${tradeColumns} FROM trade_accounts WHERE storefront_id = $1 AND customer_id = $2`, [req.storefront.id, id]);
    if (!rows[0]) throw notFound('Trade account');
    const acct = { ...rows[0], creditLimitMinor: Number(rows[0].creditLimitMinor) };
    if (rows[0].status !== 'approved') return acct;
    const used = await creditUsed(db, id);
    const t = await approvedTrade(db, req.storefront.id, id);
    return { ...acct, creditUsedMinor: Number(used), creditAvailableMinor: Number((t?.creditLimitMinor ?? 0n) - used), statement: await tradeStatement(db, id) };
  });

  // ---- phone notifications
  const subBody = z.object({ endpoint: z.string().url().max(1000).refine((u) => u.startsWith('https://'), 'Must be https'), keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(5).max(100) }) });

  app.put('/shop/:slug/me/push', async (req, reply) => {
    const body = subBody.parse(req.body);
    const id = await customer(req);
    // A device belongs to whoever subscribed last on it.
    await db.query(
      `INSERT INTO push_subscriptions (organization_id, customer_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (endpoint) DO UPDATE SET customer_id = $2, organization_id = $1, p256dh = $4, auth = $5, user_agent = $6`,
      [req.storefront.organizationId, id, body.endpoint, body.keys.p256dh, body.keys.auth, String(req.headers['user-agent'] ?? '').slice(0, 200)],
    );
    return reply.status(204).send();
  });

  app.delete('/shop/:slug/me/push', async (req, reply) => {
    const body = z.object({ endpoint: z.string().url().max(1000) }).parse(req.body);
    const id = await customer(req);
    await db.query('DELETE FROM push_subscriptions WHERE customer_id = $1 AND endpoint = $2', [id, body.endpoint]);
    return reply.status(204).send();
  });
};
