import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, grantsFor } from '../auth/authorize.js';
import { withTx, type Db } from '../db.js';
import { notFound } from '../errors.js';
import { audit, uuid } from '../inventory/common.js';

/** The review queue: a person reads each review before the public does. */
export const reviewRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/reviews', async (req) => {
    const q = z.object({ status: z.enum(['pending', 'published', 'rejected']).default('pending'), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const grants = await grantsFor(db, req.actor, 'reviews.moderate');
    const { rows } = await db.query(
      `SELECT r.id, r.rating, r.title, r.body, r.display_name AS "name", r.status, r.created_at AS "createdAt", sp.title AS "productTitle", s.name AS "storeName",
              s.legal_entity_id AS "legalEntityId", e.country_code AS "countryCode"
         FROM product_reviews r JOIN storefront_products sp ON sp.id = r.storefront_product_id JOIN storefronts s ON s.id = sp.storefront_id
         JOIN legal_entities e ON e.id = s.legal_entity_id
        WHERE r.organization_id = $1 AND r.status = $2 ORDER BY r.created_at DESC LIMIT $3`,
      [req.actor.organizationId, q.status, q.limit],
    );
    return rows
      .filter((r) => grants.group || grants.countries.has(r.countryCode.trim()) || grants.legalEntities.has(r.legalEntityId))
      .map(({ countryCode: _c, legalEntityId: _l, ...r }) => r);
  });

  app.post('/reviews/:id/moderate', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ status: z.enum(['published', 'rejected']) }).parse(req.body);
    const { actor } = req;
    return withTx(db, async (tx) => {
      const found = await tx.query<{ legal_entity_id: string }>(
        `SELECT s.legal_entity_id FROM product_reviews r JOIN storefront_products sp ON sp.id = r.storefront_product_id JOIN storefronts s ON s.id = sp.storefront_id
          WHERE r.id = $1 AND r.organization_id = $2 FOR UPDATE OF r`,
        [id, actor.organizationId],
      );
      if (!found.rows[0]) throw notFound('Review');
      await authorize(tx, actor, 'reviews.moderate', { kind: 'legal_entity', legalEntityId: found.rows[0].legal_entity_id });
      await tx.query('UPDATE product_reviews SET status = $2, moderated_by = $3, moderated_at = now() WHERE id = $1', [id, body.status, actor.userId]);
      await audit(tx, req, `review.${body.status}`, 'review', id, body);
      return { id, status: body.status };
    });
  });
};
