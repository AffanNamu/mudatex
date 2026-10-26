import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, grantsFor } from '../auth/authorize.js';
import { withTx, type Db, type Tx } from '../db.js';
import { conflict, invalid, notFound } from '../errors.js';
import { audit, loadStockLocation, uuid } from '../inventory/common.js';

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60);
const httpsUrl = z.string().url().max(500).refine((u) => u.startsWith('https://'), 'Images must be https URLs');

const contactBody = z
  .object({
    whatsapp: z.string().regex(/^\+?[0-9]{7,15}$/).optional(),
    phone: z.string().regex(/^\+?[0-9 ()-]{7,20}$/).optional(),
    email: z.string().email().max(200).optional(),
    address: z.string().max(300).optional(),
    // where shoppers send bank transfers; shown on the order page
    bankName: z.string().max(100).optional(),
    accountName: z.string().max(150).optional(),
    accountNumber: z.string().regex(/^[0-9]{6,20}$/).optional(),
  })
  .strict();

/** Where the shop lives, so a payment page can send the shopper back to it. */
const siteUrl = z.string().url().max(200).refine((u) => /^(https:\/\/|http:\/\/localhost)/.test(u), 'Must be an https address').transform((u) => u.replace(/\/$/, ''));

const createBody = z.object({
  legalEntityId: uuid,
  slug,
  name: z.string().trim().min(2).max(100),
  priceListId: uuid,
  stockLocationIds: z.array(uuid).min(1).max(50),
  tagline: z.string().max(200).optional(),
  contact: contactBody.optional(),
  siteUrl: siteUrl.optional(),
});

const updateBody = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  tagline: z.string().max(200).nullable().optional(),
  contact: contactBody.optional(),
  stockLocationIds: z.array(uuid).min(1).max(50).optional(),
  status: z.enum(['draft', 'live', 'closed']).optional(),
  siteUrl: siteUrl.nullable().optional(),
});

const departmentBody = z.object({
  slug,
  name: z.string().trim().min(1).max(80),
  imageUrl: httpsUrl.nullable().optional(),
  sort: z.number().int().min(0).max(10000).optional(),
});

const publishBody = z.object({
  slug: slug.optional(),
  title: z.string().trim().min(2).max(160).optional(),
  description: z.string().max(5000).nullable().optional(),
  departmentId: uuid.nullable().optional(),
  brand: z.string().max(80).nullable().optional(),
  images: z.array(httpsUrl).max(12).optional(),
  badges: z.array(z.string().trim().min(1).max(30)).max(6).optional(),
  published: z.boolean().optional(),
  sort: z.number().int().min(0).max(100000).optional(),
});

const zoneBody = z.object({
  name: z.string().trim().min(1).max(100),
  countryCode: z.string().regex(/^[A-Za-z]{2}$/).transform((c) => c.toUpperCase()),
  states: z.array(z.string().trim().min(1).max(80)).max(60).default([]),
  feeMinor: z.number().int().min(0).max(1_000_000_000),
  freeOverMinor: z.number().int().min(1).max(1_000_000_000_000).nullable().optional(),
  etaDaysMin: z.number().int().min(0).max(60).default(1),
  etaDaysMax: z.number().int().min(0).max(90).default(3),
  active: z.boolean().default(true),
});

const STOREFRONT_COLUMNS = `s.id, s.legal_entity_id AS "legalEntityId", s.slug, s.name, s.price_list_id AS "priceListId", s.currency,
  s.stock_location_ids AS "stockLocationIds", s.status, s.tagline, s.contact, s.site_url AS "siteUrl"`;

const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

export const storefrontAdminRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  /** Loads a storefront of the actor's organisation and checks they may manage it. */
  async function managed(tx: Tx | Db, req: { actor: { userId: string; organizationId: string } }, id: string) {
    const { rows } = await tx.query<{ id: string; legal_entity_id: string; status: string }>(
      'SELECT id, legal_entity_id, status FROM storefronts WHERE id = $1 AND organization_id = $2',
      [id, req.actor.organizationId],
    );
    if (!rows[0]) throw notFound('Storefront');
    await authorize(tx, req.actor, 'storefront.manage', { kind: 'legal_entity', legalEntityId: rows[0].legal_entity_id });
    return { id: rows[0].id, legalEntityId: rows[0].legal_entity_id, status: rows[0].status };
  }

  async function checkLocations(tx: Tx, organizationId: string, legalEntityId: string, ids: string[]) {
    for (const id of new Set(ids)) {
      const loc = await loadStockLocation(tx, organizationId, id);
      if (loc.legalEntityId !== legalEntityId) throw invalid('Stock locations must belong to the storefront\'s legal entity');
    }
  }

  app.post('/storefronts', async (req, reply) => {
    const body = createBody.parse(req.body);
    const { actor } = req;
    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'storefront.manage', { kind: 'legal_entity', legalEntityId: body.legalEntityId });
      const list = await tx.query<{ currency: string }>(
        'SELECT currency FROM price_lists WHERE id = $1 AND legal_entity_id = $2 AND organization_id = $3',
        [body.priceListId, body.legalEntityId, actor.organizationId],
      );
      if (!list.rows[0]) throw invalid('Price list does not belong to this legal entity');
      await checkLocations(tx, actor.organizationId, body.legalEntityId, body.stockLocationIds);
      const { rows } = await tx.query(
        `INSERT INTO storefronts (organization_id, legal_entity_id, slug, name, price_list_id, currency, stock_location_ids, tagline, contact, site_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, legal_entity_id AS "legalEntityId", slug, name, price_list_id AS "priceListId", currency,
                   stock_location_ids AS "stockLocationIds", status, tagline, contact, site_url AS "siteUrl"`,
        [actor.organizationId, body.legalEntityId, body.slug, body.name, body.priceListId, list.rows[0].currency, [...new Set(body.stockLocationIds)], body.tagline ?? null, body.contact ?? {}, body.siteUrl ?? null],
      );
      await audit(tx, req, 'storefront.create', 'storefront', rows[0].id, rows[0]);
      return rows[0];
    });
    return reply.status(201).send(created);
  });

  app.get('/storefronts', async (req) => {
    const grants = await grantsFor(db, req.actor, 'storefront.manage');
    const { rows } = await db.query(
      `SELECT ${STOREFRONT_COLUMNS}, e.country_code AS "countryCode",
              (SELECT count(*)::int FROM storefront_products sp WHERE sp.storefront_id = s.id AND sp.published) AS "publishedProducts"
         FROM storefronts s JOIN legal_entities e ON e.id = s.legal_entity_id
        WHERE s.organization_id = $1 ORDER BY s.name`,
      [req.actor.organizationId],
    );
    return rows
      .filter((r) => grants.group || grants.countries.has(r.countryCode.trim()) || grants.legalEntities.has(r.legalEntityId))
      .map(({ countryCode: _c, ...r }) => r);
  });

  app.put('/storefronts/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = updateBody.parse(req.body);
    return withTx(db, async (tx) => {
      const sf = await managed(tx, req, id);
      if (body.stockLocationIds) await checkLocations(tx, req.actor.organizationId, sf.legalEntityId, body.stockLocationIds);
      if (body.status === 'live') {
        const published = await tx.query('SELECT 1 FROM storefront_products WHERE storefront_id = $1 AND published LIMIT 1', [id]);
        if (!published.rowCount) throw conflict('Publish at least one product before going live');
      }
      const { rows } = await tx.query(
        `UPDATE storefronts SET name = COALESCE($2, name), tagline = CASE WHEN $3::boolean THEN $4 ELSE tagline END,
                contact = COALESCE($5, contact), stock_location_ids = COALESCE($6, stock_location_ids),
                status = COALESCE($7, status), site_url = CASE WHEN $8::boolean THEN $9 ELSE site_url END, updated_at = now()
          WHERE id = $1
        RETURNING id, legal_entity_id AS "legalEntityId", slug, name, price_list_id AS "priceListId", currency,
                  stock_location_ids AS "stockLocationIds", status, tagline, contact, site_url AS "siteUrl"`,
        [id, body.name ?? null, body.tagline !== undefined, body.tagline ?? null, body.contact ?? null, body.stockLocationIds ? [...new Set(body.stockLocationIds)] : null, body.status ?? null, body.siteUrl !== undefined, body.siteUrl ?? null],
      );
      await audit(tx, req, 'storefront.update', 'storefront', id, body);
      return rows[0];
    });
  });

  // ---- departments
  app.get('/storefronts/:id/departments', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await managed(db, req, id);
    const { rows } = await db.query(
      `SELECT id, slug, name, image_url AS "imageUrl", sort FROM storefront_departments WHERE storefront_id = $1 ORDER BY sort, name`,
      [id],
    );
    return rows;
  });

  app.post('/storefronts/:id/departments', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = departmentBody.parse(req.body);
    const created = await withTx(db, async (tx) => {
      await managed(tx, req, id);
      const { rows } = await tx.query(
        `INSERT INTO storefront_departments (storefront_id, slug, name, image_url, sort) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, slug, name, image_url AS "imageUrl", sort`,
        [id, body.slug, body.name, body.imageUrl ?? null, body.sort ?? 0],
      );
      await audit(tx, req, 'storefront.department.create', 'storefront', id, rows[0]);
      return rows[0];
    });
    return reply.status(201).send(created);
  });

  app.put('/storefronts/:id/departments/:departmentId', async (req) => {
    const params = z.object({ id: uuid, departmentId: uuid }).parse(req.params);
    const body = departmentBody.parse(req.body);
    return withTx(db, async (tx) => {
      await managed(tx, req, params.id);
      const { rows } = await tx.query(
        `UPDATE storefront_departments SET slug = $3, name = $4, image_url = $5, sort = COALESCE($6, sort)
          WHERE id = $2 AND storefront_id = $1 RETURNING id, slug, name, image_url AS "imageUrl", sort`,
        [params.id, params.departmentId, body.slug, body.name, body.imageUrl ?? null, body.sort ?? null],
      );
      if (!rows[0]) throw notFound('Department');
      await audit(tx, req, 'storefront.department.update', 'storefront', params.id, rows[0]);
      return rows[0];
    });
  });

  app.delete('/storefronts/:id/departments/:departmentId', async (req, reply) => {
    const params = z.object({ id: uuid, departmentId: uuid }).parse(req.params);
    await withTx(db, async (tx) => {
      await managed(tx, req, params.id);
      const used = await tx.query('SELECT 1 FROM storefront_products WHERE department_id = $1 LIMIT 1', [params.departmentId]);
      if (used.rowCount) throw conflict('Move or unpublish this department\'s products first');
      const gone = await tx.query('DELETE FROM storefront_departments WHERE id = $1 AND storefront_id = $2', [params.departmentId, params.id]);
      if (!gone.rowCount) throw notFound('Department');
      await audit(tx, req, 'storefront.department.delete', 'storefront', params.id, { departmentId: params.departmentId });
    });
    return reply.status(204).send();
  });

  // ---- publishing
  app.get('/storefronts/:id/products', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await managed(db, req, id);
    const { rows } = await db.query(
      `SELECT sp.product_id AS "productId", p.name AS "productName", sp.slug, sp.title, sp.brand, sp.department_id AS "departmentId",
              sp.images, sp.badges, sp.published, sp.sort,
              EXISTS (SELECT 1 FROM product_variants v JOIN price_list_items i ON i.variant_id = v.id AND i.price_list_id = s.price_list_id
                       AND i.effective_from <= now() AND (i.effective_to IS NULL OR i.effective_to > now())
                       WHERE v.product_id = p.id AND v.status = 'active') AS priced
         FROM storefront_products sp JOIN products p ON p.id = sp.product_id JOIN storefronts s ON s.id = sp.storefront_id
        WHERE sp.storefront_id = $1 ORDER BY sp.sort, p.name`,
      [id],
    );
    return rows;
  });

  // Creates or updates how one catalogue product appears in this store. Publishing needs a current price.
  app.put('/storefronts/:id/products/:productId', async (req) => {
    const params = z.object({ id: uuid, productId: uuid }).parse(req.params);
    const body = publishBody.parse(req.body);
    return withTx(db, async (tx) => {
      await managed(tx, req, params.id);
      const product = await tx.query<{ name: string; description: string | null }>(
        `SELECT name, description FROM products WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
        [params.productId, req.actor.organizationId],
      );
      if (!product.rows[0]) throw notFound('Product');
      if (body.departmentId) {
        const dep = await tx.query('SELECT 1 FROM storefront_departments WHERE id = $1 AND storefront_id = $2', [body.departmentId, params.id]);
        if (!dep.rowCount) throw invalid('Department does not belong to this storefront');
      }
      if (body.published) {
        const priced = await tx.query(
          `SELECT 1 FROM product_variants v JOIN price_list_items i ON i.variant_id = v.id
             JOIN storefronts s ON s.id = $2 AND i.price_list_id = s.price_list_id
            WHERE v.product_id = $1 AND v.status = 'active' AND i.effective_from <= now() AND (i.effective_to IS NULL OR i.effective_to > now()) LIMIT 1`,
          [params.productId, params.id],
        );
        if (!priced.rowCount) throw conflict('Give at least one variant a current price on this store\'s price list before publishing');
      }
      const existing = await tx.query<{ id: string }>('SELECT id FROM storefront_products WHERE storefront_id = $1 AND product_id = $2 FOR UPDATE', [params.id, params.productId]);
      const title = body.title ?? product.rows[0].name;
      const columns = `product_id AS "productId", slug, title, description, brand, department_id AS "departmentId", images, badges, published, sort`;
      if (!existing.rows[0]) {
        const { rows } = await tx.query(
          `INSERT INTO storefront_products (storefront_id, product_id, slug, title, description, department_id, brand, images, badges, published, sort)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${columns}`,
          [params.id, params.productId, body.slug ?? (slugify(title) || 'product'), title, body.description ?? product.rows[0].description, body.departmentId ?? null,
           body.brand ?? null, JSON.stringify(body.images ?? []), body.badges ?? [], body.published ?? false, body.sort ?? 0],
        );
        await audit(tx, req, 'storefront.product.publish', 'storefront', params.id, rows[0]);
        return rows[0];
      }
      const { rows } = await tx.query(
        `UPDATE storefront_products SET
            slug = COALESCE($3, slug), title = COALESCE($4, title),
            description = CASE WHEN $5::boolean THEN $6 ELSE description END,
            department_id = CASE WHEN $7::boolean THEN $8::uuid ELSE department_id END,
            brand = CASE WHEN $9::boolean THEN $10 ELSE brand END,
            images = COALESCE($11::jsonb, images), badges = COALESCE($12, badges),
            published = COALESCE($13, published), sort = COALESCE($14, sort), updated_at = now()
          WHERE id = $1 AND storefront_id = $2 RETURNING ${columns}`,
        [existing.rows[0].id, params.id, body.slug ?? null, body.title ?? null,
         body.description !== undefined, body.description ?? null, body.departmentId !== undefined, body.departmentId ?? null,
         body.brand !== undefined, body.brand ?? null, body.images ? JSON.stringify(body.images) : null, body.badges ?? null,
         body.published ?? null, body.sort ?? null],
      );
      await audit(tx, req, 'storefront.product.update', 'storefront', params.id, rows[0]);
      return rows[0];
    });
  });

  // ---- delivery zones
  const zoneColumns = `id, name, country_code AS "countryCode", states, fee_minor AS "feeMinor", free_over_minor AS "freeOverMinor",
    eta_days_min AS "etaDaysMin", eta_days_max AS "etaDaysMax", active`;
  const zoneOut = (r: any) => ({ ...r, feeMinor: Number(r.feeMinor), freeOverMinor: r.freeOverMinor === null ? null : Number(r.freeOverMinor) });

  app.get('/storefronts/:id/delivery-zones', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await managed(db, req, id);
    const { rows } = await db.query(`SELECT ${zoneColumns} FROM delivery_zones WHERE storefront_id = $1 ORDER BY country_code, name`, [id]);
    return rows.map(zoneOut);
  });

  app.post('/storefronts/:id/delivery-zones', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = zoneBody.parse(req.body);
    if (body.etaDaysMax < body.etaDaysMin) throw invalid('etaDaysMax is below etaDaysMin');
    const created = await withTx(db, async (tx) => {
      await managed(tx, req, id);
      const { rows } = await tx.query(
        `INSERT INTO delivery_zones (storefront_id, name, country_code, states, fee_minor, free_over_minor, eta_days_min, eta_days_max, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${zoneColumns}`,
        [id, body.name, body.countryCode, body.states.map((s) => s.toLowerCase()), body.feeMinor, body.freeOverMinor ?? null, body.etaDaysMin, body.etaDaysMax, body.active],
      );
      await audit(tx, req, 'storefront.zone.create', 'storefront', id, rows[0]);
      return zoneOut(rows[0]);
    });
    return reply.status(201).send(created);
  });

  app.put('/storefronts/:id/delivery-zones/:zoneId', async (req) => {
    const params = z.object({ id: uuid, zoneId: uuid }).parse(req.params);
    const body = zoneBody.parse(req.body);
    if (body.etaDaysMax < body.etaDaysMin) throw invalid('etaDaysMax is below etaDaysMin');
    return withTx(db, async (tx) => {
      await managed(tx, req, params.id);
      const { rows } = await tx.query(
        `UPDATE delivery_zones SET name = $3, country_code = $4, states = $5, fee_minor = $6, free_over_minor = $7,
                eta_days_min = $8, eta_days_max = $9, active = $10
          WHERE id = $2 AND storefront_id = $1 RETURNING ${zoneColumns}`,
        [params.id, params.zoneId, body.name, body.countryCode, body.states.map((s) => s.toLowerCase()), body.feeMinor, body.freeOverMinor ?? null, body.etaDaysMin, body.etaDaysMax, body.active],
      );
      if (!rows[0]) throw notFound('Delivery zone');
      await audit(tx, req, 'storefront.zone.update', 'storefront', params.id, rows[0]);
      return zoneOut(rows[0]);
    });
  });

  app.delete('/storefronts/:id/delivery-zones/:zoneId', async (req, reply) => {
    const params = z.object({ id: uuid, zoneId: uuid }).parse(req.params);
    await withTx(db, async (tx) => {
      await managed(tx, req, params.id);
      const gone = await tx.query('DELETE FROM delivery_zones WHERE id = $1 AND storefront_id = $2', [params.zoneId, params.id]);
      if (!gone.rowCount) throw notFound('Delivery zone');
      await audit(tx, req, 'storefront.zone.delete', 'storefront', params.id, { zoneId: params.zoneId });
    });
    return reply.status(204).send();
  });
};
