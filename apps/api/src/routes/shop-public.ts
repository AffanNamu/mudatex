import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import { invalid } from '../errors.js';
import { MAX_ORDER_LINES, quoteBasket } from '../shop/orders.js';
import { cardsFor, loadLiveStorefront, productDetail, quoteDelivery } from '../shop/catalog.js';

const slugParam = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,60}$/) });
const money = z.string().regex(/^\d{1,12}(\.\d{1,4})?$/);

const listQuery = z.object({
  department: z.string().regex(/^[a-z0-9-]{1,60}$/).optional(),
  q: z.string().trim().min(1).max(80).optional(),
  sort: z.enum(['featured', 'newest', 'price_asc', 'price_desc']).default('featured'),
  minPrice: money.optional(),
  maxPrice: money.optional(),
  inStock: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(1).max(60).default(24),
});

const quoteBody = z.object({
  countryCode: z.string().regex(/^[A-Za-z]{2}$/),
  state: z.string().trim().min(1).max(80),
  subtotalMinor: z.number().int().min(0),
});

const basketBody = z.object({
  lines: z.array(z.object({
    variantId: z.string().uuid(),
    quantity: z.string().regex(/^\d+(\.\d+)?$/),
    unitId: z.string().uuid().optional(),
  })).min(1).max(MAX_ORDER_LINES),
  to: z.object({ countryCode: z.string().regex(/^[A-Za-z]{2}$/), state: z.string().trim().min(1).max(80) }).optional(),
});

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The public shop window. No sign-in; everything is derived on the server, and storefronts that are not live do not
 * exist as far as these endpoints are concerned.
 */
export const shopPublicRoutes: FastifyPluginAsync<{ db: Db; cardPayments?: boolean }> = async (app, { db, cardPayments = false }) => {
  app.addHook('onSend', async (req, reply) => {
    if (req.method === 'GET' && reply.statusCode === 200) {
      reply.header('cache-control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=300');
    }
  });

  app.get('/shop/:slug', async (req) => {
    const { slug } = slugParam.parse(req.params);
    const sf = await loadLiveStorefront(db, slug);
    const departments = await db.query(
      `SELECT d.slug, d.name, d.image_url AS "imageUrl",
              (SELECT count(*)::int FROM storefront_products sp WHERE sp.department_id = d.id AND sp.published) AS "productCount"
         FROM storefront_departments d WHERE d.storefront_id = $1 ORDER BY d.sort, d.name`,
      [sf.id],
    );
    const featured = await db.query(
      `SELECT sp.id, sp.product_id AS "productId", sp.slug, sp.title, sp.brand, sp.images, sp.badges,
              d.slug AS "departmentSlug", d.name AS "departmentName"
         FROM storefront_products sp JOIN products p ON p.id = sp.product_id AND p.status = 'active'
         LEFT JOIN storefront_departments d ON d.id = sp.department_id
        WHERE sp.storefront_id = $1 AND sp.published
        ORDER BY sp.sort, sp.created_at DESC LIMIT 12`,
      [sf.id],
    );
    return {
      slug: sf.slug,
      name: sf.name,
      tagline: sf.tagline,
      currency: sf.currency,
      minorUnit: sf.minorUnit,
      contact: sf.contact,
      // Card payments need both a payment provider on the server and the store's own web address for the return trip.
      cardPayments: cardPayments && !!sf.siteUrl,
      departments: departments.rows,
      featured: await cardsFor(db, sf, featured.rows),
    };
  });

  app.get('/shop/:slug/products', async (req) => {
    const { slug } = slugParam.parse(req.params);
    const q = listQuery.parse(req.query);
    const sf = await loadLiveStorefront(db, slug);

    const params: unknown[] = [sf.id, sf.priceListId];
    const where: string[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;
    if (q.department) where.push(`d.slug = ${add(q.department)}`);
    if (q.q) {
      const like = add(`%${escapeLike(q.q)}%`);
      where.push(`(sp.title ILIKE ${like} OR sp.brand ILIKE ${like} OR sp.description ILIKE ${like})`);
    }
    if (q.minPrice) where.push(`pr.min_price >= ${add(q.minPrice)}::numeric`);
    if (q.maxPrice) where.push(`pr.min_price <= ${add(q.maxPrice)}::numeric`);
    if (q.inStock === 'true') {
      where.push(`EXISTS (SELECT 1 FROM product_variants v2 JOIN stock_balances b ON b.variant_id = v2.id
                           LEFT JOIN stock_lots l ON l.id = b.lot_id
                          WHERE v2.product_id = p.id AND b.state = 'on_hand' AND b.location_id = ANY(${add(sf.stockLocationIds)}::uuid[])
                            AND b.quantity - b.reserved > 0 AND (l.id IS NULL OR l.hold_status = 'released'))`);
    }
    const order = {
      featured: 'sp.sort, sp.created_at DESC',
      newest: 'sp.created_at DESC',
      price_asc: 'pr.min_price, sp.created_at DESC',
      price_desc: 'pr.min_price DESC, sp.created_at DESC',
    }[q.sort];
    if (q.minPrice && q.maxPrice && Number(q.minPrice) > Number(q.maxPrice)) throw invalid('minPrice is above maxPrice');
    const limit = add(q.limit);
    const offset = add((q.page - 1) * q.limit);

    const { rows } = await db.query(
      `SELECT sp.id, sp.product_id AS "productId", sp.slug, sp.title, sp.brand, sp.images, sp.badges,
              d.slug AS "departmentSlug", d.name AS "departmentName", count(*) OVER()::int AS total
         FROM storefront_products sp
         JOIN products p ON p.id = sp.product_id AND p.status = 'active'
         LEFT JOIN storefront_departments d ON d.id = sp.department_id
         JOIN LATERAL (
           SELECT MIN(i.unit_price) AS min_price
             FROM product_variants v
             JOIN price_list_items i ON i.variant_id = v.id AND i.price_list_id = $2
                  AND i.effective_from <= now() AND (i.effective_to IS NULL OR i.effective_to > now())
            WHERE v.product_id = p.id AND v.status = 'active'
         ) pr ON pr.min_price IS NOT NULL
        WHERE sp.storefront_id = $1 AND sp.published ${where.length ? 'AND ' + where.join(' AND ') : ''}
        ORDER BY ${order}
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return {
      page: q.page,
      limit: q.limit,
      total: rows[0]?.total ?? 0,
      items: await cardsFor(db, sf, rows),
    };
  });

  app.get('/shop/:slug/products/:productSlug', async (req) => {
    const { slug, productSlug } = z.object({ ...slugParam.shape, productSlug: z.string().regex(/^[a-z0-9-]{1,80}$/) }).parse(req.params);
    const sf = await loadLiveStorefront(db, slug);
    return productDetail(db, sf, productSlug);
  });

  // Prices a basket with the same engine as checkout. Nothing is held and nothing is stored.
  app.post('/shop/:slug/basket', async (req) => {
    const { slug } = slugParam.parse(req.params);
    const body = basketBody.parse(req.body);
    const sf = await loadLiveStorefront(db, slug);
    return quoteBasket(db, sf, body.lines, body.to);
  });

  // Delivery fee for a place and basket value. The most specific zone wins (a named state beats a whole country).
  app.post('/shop/:slug/delivery-quote', async (req) => {
    const { slug } = slugParam.parse(req.params);
    const body = quoteBody.parse(req.body);
    const sf = await loadLiveStorefront(db, slug);
    return quoteDelivery(db, sf, body.countryCode, body.state, body.subtotalMinor);
  });
};
