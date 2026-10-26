import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, grantsFor } from '../auth/authorize.js';
import { withTx, type Db } from '../db.js';
import { notFound } from '../errors.js';
import { audit, uuid } from '../inventory/common.js';

const listQuery = z.object({
  status: z.enum(['new', 'in_progress', 'closed']).optional(),
  kind: z.enum(['contact', 'wholesale', 'custom_order', 'careers']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const COLUMNS = `q.id, q.kind, q.name, q.email, q.phone, q.company, q.message, q.status, q.note, q.created_at AS "createdAt", s.name AS "storeName"`;

/** The inbox for messages from the public site. */
export const enquiryRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/enquiries', async (req) => {
    const q = listQuery.parse(req.query);
    const grants = await grantsFor(db, req.actor, 'enquiries.manage');
    const { rows } = await db.query(
      `SELECT ${COLUMNS}, s.legal_entity_id AS "legalEntityId", e.country_code AS "countryCode"
         FROM enquiries q JOIN storefronts s ON s.id = q.storefront_id JOIN legal_entities e ON e.id = s.legal_entity_id
        WHERE q.organization_id = $1 AND ($2::text IS NULL OR q.status = $2) AND ($3::text IS NULL OR q.kind = $3)
        ORDER BY q.created_at DESC LIMIT $4`,
      [req.actor.organizationId, q.status ?? null, q.kind ?? null, q.limit],
    );
    return rows
      .filter((r) => grants.group || grants.countries.has(r.countryCode.trim()) || grants.legalEntities.has(r.legalEntityId))
      .map(({ countryCode: _c, legalEntityId: _l, ...r }) => r);
  });

  app.post('/enquiries/:id/status', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ status: z.enum(['new', 'in_progress', 'closed']), note: z.string().trim().max(1000).optional() }).parse(req.body);
    const { actor } = req;
    return withTx(db, async (tx) => {
      const found = await tx.query<{ legal_entity_id: string }>(
        `SELECT s.legal_entity_id FROM enquiries q JOIN storefronts s ON s.id = q.storefront_id WHERE q.id = $1 AND q.organization_id = $2 FOR UPDATE OF q`,
        [id, actor.organizationId],
      );
      if (!found.rows[0]) throw notFound('Enquiry');
      await authorize(tx, actor, 'enquiries.manage', { kind: 'legal_entity', legalEntityId: found.rows[0].legal_entity_id });
      const { rows } = await tx.query(
        `UPDATE enquiries q SET status = $2, note = COALESCE($3, note), handled_by = $4, updated_at = now() FROM storefronts s
          WHERE q.id = $1 AND s.id = q.storefront_id RETURNING ${COLUMNS}`,
        [id, body.status, body.note ?? null, actor.userId],
      );
      await audit(tx, req, 'enquiry.update', 'enquiry', id, body);
      return rows[0];
    });
  });
};
