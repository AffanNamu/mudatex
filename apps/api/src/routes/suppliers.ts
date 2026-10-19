import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, authorizeAnywhere } from '../auth/authorize.js';
import { withTx, type Db } from '../db.js';
import { notFound } from '../errors.js';
import { audit, uuid } from '../inventory/common.js';

const supplierBody = z.object({
  code: z.string().regex(/^[A-Z0-9_-]{2,20}$/),
  name: z.string().min(1).max(200),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  defaultCurrency: z.string().regex(/^[A-Z]{3}$/),
  paymentTermsDays: z.number().int().min(0).max(365).default(0),
});

const COLS = `id, code, name, country_code AS "countryCode", default_currency AS "defaultCurrency",
              payment_terms_days AS "paymentTermsDays", status`;

export const supplierRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/procurement/suppliers', async (req, reply) => {
    const body = supplierBody.parse(req.body);
    const { actor } = req;
    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'procurement.supplier.manage', { kind: 'organization' });
      const { rows } = await tx.query(
        `INSERT INTO suppliers (organization_id, code, name, country_code, default_currency, payment_terms_days)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
        [actor.organizationId, body.code, body.name, body.countryCode, body.defaultCurrency, body.paymentTermsDays],
      );
      await audit(tx, req, 'supplier.create', 'supplier', rows[0].id, rows[0]);
      return rows[0];
    });
    return reply.status(201).send(created);
  });

  const setStatus = (status: 'active' | 'blocked') => async (req: import('fastify').FastifyRequest) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return withTx(db, async (tx) => {
      await authorize(tx, actor, 'procurement.supplier.manage', { kind: 'organization' });
      const { rows } = await tx.query(`UPDATE suppliers SET status = $3 WHERE id = $1 AND organization_id = $2 RETURNING ${COLS}`, [id, actor.organizationId, status]);
      if (!rows[0]) throw notFound('Supplier');
      await audit(tx, req, `supplier.${status === 'blocked' ? 'block' : 'unblock'}`, 'supplier', id);
      return rows[0];
    });
  };
  app.post('/procurement/suppliers/:id/block', setStatus('blocked'));
  app.post('/procurement/suppliers/:id/unblock', setStatus('active'));

  app.get('/procurement/suppliers', async (req) => {
    await authorizeAnywhere(db, req.actor, 'procurement.read');
    const { rows } = await db.query(`SELECT ${COLS} FROM suppliers WHERE organization_id = $1 ORDER BY code`, [req.actor.organizationId]);
    return rows;
  });
};
