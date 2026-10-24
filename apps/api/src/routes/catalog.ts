import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { authorize, authorizeAnywhere } from '../auth/authorize.js';
import { withTx, type Db } from '../db.js';
import { invalid, notFound } from '../errors.js';

const unitBody = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]{0,15}$/),
    name: z.string().min(1),
    kind: z.enum(['discrete', 'decimal']),
    precision: z.number().int().min(0).max(6),
  })
  .refine((u) => u.kind === 'decimal' || u.precision === 0, 'Discrete units must have precision 0');

const decimal = z.string().regex(/^\d+(\.\d{1,8})?$/);

const productBody = z.object({
  name: z.string().min(1).max(300),
  description: z.string().optional(),
  category: z.string().optional(),
  baseUnitId: z.string().uuid(),
  attributes: z.record(z.string(), z.unknown()).default({}),
  variants: z
    .array(
      z.object({
        sku: z.string().min(1).max(100),
        tracking: z.enum(['none', 'lot', 'roll']).default('none'),
        attributes: z.record(z.string(), z.unknown()).default({}),
        barcodes: z.array(z.string().min(1).max(64)).default([]),
      }),
    )
    .min(1),
  conversions: z
    .array(z.object({ fromUnitId: z.string().uuid(), toUnitId: z.string().uuid(), factor: decimal }))
    .default([]),
});

export const catalogRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/units', async (req, reply) => {
    const body = unitBody.parse(req.body);
    const { actor } = req;
    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'catalog.write', { kind: 'organization' });
      const { rows } = await tx.query(
        `INSERT INTO units (organization_id, code, name, kind, precision) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, code, name, kind, precision`,
        [actor.organizationId, body.code, body.name, body.kind, body.precision],
      );
      await writeAudit(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        requestId: req.id,
        action: 'unit.create',
        entityType: 'unit',
        entityId: rows[0].id,
        after: rows[0],
      });
      return rows[0];
    });
    return reply.status(201).send(created);
  });

  app.get('/units', async (req) => {
    await authorizeAnywhere(db, req.actor, 'catalog.read');
    const { rows } = await db.query(
      'SELECT id, code, name, kind, precision FROM units WHERE organization_id = $1 ORDER BY code',
      [req.actor.organizationId],
    );
    return rows;
  });

  app.post('/products', async (req, reply) => {
    const body = productBody.parse(req.body);
    const { actor } = req;

    const skus = body.variants.map((v) => v.sku);
    const barcodes = body.variants.flatMap((v) => v.barcodes);
    if (new Set(skus).size !== skus.length) throw invalid('Duplicate SKU in request');
    if (new Set(barcodes).size !== barcodes.length) throw invalid('Duplicate barcode in request');

    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'catalog.write', { kind: 'organization' });

      const unitIds = new Set([body.baseUnitId, ...body.conversions.flatMap((c) => [c.fromUnitId, c.toUnitId])]);
      const units = await tx.query('SELECT 1 FROM units WHERE organization_id = $1 AND id = ANY($2::uuid[])', [
        actor.organizationId,
        [...unitIds],
      ]);
      if (units.rowCount !== unitIds.size) throw invalid('Unknown unit');

      const p = await tx.query<{ id: string }>(
        `INSERT INTO products (organization_id, name, description, category, base_unit_id, attributes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [actor.organizationId, body.name, body.description ?? null, body.category ?? null, body.baseUnitId, body.attributes],
      );
      const productId = p.rows[0]!.id;

      const variantIds: string[] = [];
      for (const v of body.variants) {
        const r = await tx.query<{ id: string }>(
          `INSERT INTO product_variants (organization_id, product_id, sku, tracking, attributes) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [actor.organizationId, productId, v.sku, v.tracking, v.attributes],
        );
        const variantId = r.rows[0]!.id;
        variantIds.push(variantId);
        for (const code of v.barcodes) {
          await tx.query('INSERT INTO variant_barcodes (organization_id, barcode, variant_id) VALUES ($1, $2, $3)', [
            actor.organizationId,
            code,
            variantId,
          ]);
        }
      }
      for (const c of body.conversions) {
        await tx.query(
          'INSERT INTO product_unit_conversions (product_id, from_unit_id, to_unit_id, factor) VALUES ($1, $2, $3, $4)',
          [productId, c.fromUnitId, c.toUnitId, c.factor],
        );
      }

      const result = { id: productId, name: body.name, baseUnitId: body.baseUnitId, variantIds };
      await writeAudit(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        requestId: req.id,
        action: 'product.create',
        entityType: 'product',
        entityId: productId,
        after: { ...body, id: productId },
      });
      return result;
    });
    return reply.status(201).send(created);
  });

  app.get('/products', async (req) => {
    await authorizeAnywhere(db, req.actor, 'catalog.read');
    const q = z
      .object({
        status: z.enum(['active', 'archived']).default('active'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.description, p.category, p.base_unit_id AS "baseUnitId", p.attributes, p.status,
              COALESCE(json_agg(json_build_object(
                'id', v.id, 'sku', v.sku, 'tracking', v.tracking, 'attributes', v.attributes, 'status', v.status,
                'barcodes', COALESCE((SELECT json_agg(b.barcode ORDER BY b.barcode) FROM variant_barcodes b WHERE b.variant_id = v.id), '[]'::json)
              ) ORDER BY v.sku) FILTER (WHERE v.id IS NOT NULL), '[]'::json) AS variants
         FROM products p LEFT JOIN product_variants v ON v.product_id = p.id
        WHERE p.organization_id = $1 AND p.status = $2
        GROUP BY p.id ORDER BY p.name, p.id LIMIT $3 OFFSET $4`,
      [req.actor.organizationId, q.status, q.limit, q.offset],
    );
    return rows;
  });

  // Archiving keeps the row readable for historical documents; nothing is deleted.
  app.post('/products/:id/archive', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { actor } = req;
    return withTx(db, async (tx) => {
      await authorize(tx, actor, 'catalog.write', { kind: 'organization' });
      const { rows } = await tx.query(
        `UPDATE products SET status = 'archived', updated_at = now()
          WHERE id = $1 AND organization_id = $2 RETURNING id, status`,
        [id, actor.organizationId],
      );
      if (!rows[0]) throw notFound('Product');
      await writeAudit(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        requestId: req.id,
        action: 'product.archive',
        entityType: 'product',
        entityId: id,
      });
      return rows[0];
    });
  });

  app.get('/audit-log', async (req) => {
    await authorize(db, req.actor, 'audit.read', { kind: 'organization' });
    const q = z
      .object({
        entityType: z.string().optional(),
        entityId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    const { rows } = await db.query(
      `SELECT id, occurred_at AS "occurredAt", actor_user_id AS "actorUserId", request_id AS "requestId",
              action, entity_type AS "entityType", entity_id AS "entityId", before_state AS before, after_state AS after
         FROM audit_log
        WHERE organization_id = $1
          AND ($2::text IS NULL OR entity_type = $2) AND ($3::text IS NULL OR entity_id = $3)
        ORDER BY id DESC LIMIT $4`,
      [req.actor.organizationId, q.entityType ?? null, q.entityId ?? null, q.limit],
    );
    return rows;
  });
};
