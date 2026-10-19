import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, grantsFor } from '../auth/authorize.js';
import { withTx, type Db } from '../db.js';
import { normalize } from '../domain/decimal.js';
import { conflict, invalid, notFound } from '../errors.js';
import { audit, uuid } from '../inventory/common.js';

const taxBody = z.object({
  legalEntityId: uuid,
  code: z.string().regex(/^[A-Z0-9_]{2,30}$/),
  name: z.string().min(1).max(100),
  rate: z.string().regex(/^0(\.\d{1,6})?$/, 'Rate is a fraction below 1, e.g. 0.075'),
  priceInclusive: z.boolean(),
});

const listBody = z.object({
  legalEntityId: uuid,
  name: z.string().min(1).max(100),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const itemBody = z.object({
  variantId: uuid,
  unitPrice: z.string().regex(/^\d+(\.\d{1,4})?$/),
  taxCodeId: uuid.nullable().optional(),
  effectiveFrom: z.string().datetime().optional(),
});

export const pricingRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/pricing/tax-codes', async (req, reply) => {
    const body = taxBody.parse(req.body);
    const { actor } = req;
    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'pricing.manage', { kind: 'legal_entity', legalEntityId: body.legalEntityId });
      const { rows } = await tx.query(
        `INSERT INTO tax_codes (organization_id, legal_entity_id, code, name, rate, price_inclusive)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, legal_entity_id AS "legalEntityId", code, name, rate, price_inclusive AS "priceInclusive"`,
        [actor.organizationId, body.legalEntityId, body.code, body.name, body.rate, body.priceInclusive],
      );
      await audit(tx, req, 'tax_code.create', 'tax_code', rows[0].id, rows[0]);
      return { ...rows[0], rate: normalize(rows[0].rate) };
    });
    return reply.status(201).send(created);
  });

  app.get('/pricing/tax-codes', async (req) => {
    const grants = await grantsFor(db, req.actor, 'pos.read');
    const { rows } = await db.query<{ legalEntityId: string; countryCode: string; rate: string }>(
      `SELECT t.id, t.legal_entity_id AS "legalEntityId", e.country_code AS "countryCode", t.code, t.name, t.rate,
              t.price_inclusive AS "priceInclusive"
         FROM tax_codes t JOIN legal_entities e ON e.id = t.legal_entity_id WHERE t.organization_id = $1 ORDER BY t.code`,
      [req.actor.organizationId],
    );
    return rows
      .filter((r) => grants.group || grants.countries.has(r.countryCode.trim()) || grants.legalEntities.has(r.legalEntityId))
      .map(({ countryCode: _c, ...r }) => ({ ...r, rate: normalize(r.rate) }));
  });

  app.post('/pricing/price-lists', async (req, reply) => {
    const body = listBody.parse(req.body);
    const { actor } = req;
    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'pricing.manage', { kind: 'legal_entity', legalEntityId: body.legalEntityId });
      const { rows } = await tx.query(
        `INSERT INTO price_lists (organization_id, legal_entity_id, name, currency) VALUES ($1, $2, $3, $4)
         RETURNING id, legal_entity_id AS "legalEntityId", name, currency`,
        [actor.organizationId, body.legalEntityId, body.name, body.currency],
      );
      await audit(tx, req, 'price_list.create', 'price_list', rows[0].id, rows[0]);
      return rows[0];
    });
    return reply.status(201).send(created);
  });

  // Sets the price from `effectiveFrom` (default now). The current open-ended price, if any, ends at that instant.
  app.put('/pricing/price-lists/:id/items', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = itemBody.parse(req.body);
    const { actor } = req;
    const created = await withTx(db, async (tx) => {
      const list = await tx.query<{ legal_entity_id: string }>(
        'SELECT legal_entity_id FROM price_lists WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [id, actor.organizationId],
      );
      if (!list.rows[0]) throw notFound('Price list');
      const legalEntityId = list.rows[0].legal_entity_id;
      await authorize(tx, actor, 'pricing.manage', { kind: 'legal_entity', legalEntityId });

      const variant = await tx.query('SELECT 1 FROM product_variants WHERE id = $1 AND organization_id = $2', [body.variantId, actor.organizationId]);
      if (!variant.rowCount) throw notFound('Variant');
      if (body.taxCodeId) {
        const tax = await tx.query('SELECT 1 FROM tax_codes WHERE id = $1 AND legal_entity_id = $2', [body.taxCodeId, legalEntityId]);
        if (!tax.rowCount) throw invalid('Tax code does not belong to this price list\'s legal entity');
      }

      const from = body.effectiveFrom ? new Date(body.effectiveFrom) : new Date();
      const open = await tx.query<{ id: string; effective_from: Date }>(
        `SELECT id, effective_from FROM price_list_items
          WHERE price_list_id = $1 AND variant_id = $2 AND effective_to IS NULL FOR UPDATE`,
        [id, body.variantId],
      );
      if (open.rows[0]) {
        if (open.rows[0].effective_from >= from) throw conflict('A price already starts at or after that time');
        await tx.query('UPDATE price_list_items SET effective_to = $2 WHERE id = $1', [open.rows[0].id, from]);
      }
      try {
        const { rows } = await tx.query(
          `INSERT INTO price_list_items (price_list_id, variant_id, unit_price, tax_code_id, effective_from)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, variant_id AS "variantId", unit_price AS "unitPrice", tax_code_id AS "taxCodeId", effective_from AS "effectiveFrom"`,
          [id, body.variantId, body.unitPrice, body.taxCodeId ?? null, from],
        );
        await audit(tx, req, 'price.set', 'price_list', id, rows[0]);
        return { ...rows[0], unitPrice: normalize(rows[0].unitPrice) };
      } catch (err) {
        if ((err as { code?: string }).code === '23P01') throw conflict('Price period overlaps an existing price');
        throw err;
      }
    });
    return reply.status(201).send(created);
  });

  app.get('/pricing/price-lists/:id/items', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = z.object({ at: z.string().datetime().optional() }).parse(req.query);
    const list = await db.query<{ legal_entity_id: string }>('SELECT legal_entity_id FROM price_lists WHERE id = $1 AND organization_id = $2', [id, req.actor.organizationId]);
    if (!list.rows[0]) throw notFound('Price list');
    await authorize(db, req.actor, 'pos.read', { kind: 'legal_entity', legalEntityId: list.rows[0].legal_entity_id });
    const { rows } = await db.query<{ unitPrice: string }>(
      `SELECT id, variant_id AS "variantId", unit_price AS "unitPrice", tax_code_id AS "taxCodeId",
              effective_from AS "effectiveFrom", effective_to AS "effectiveTo"
         FROM price_list_items WHERE price_list_id = $1
          AND ($2::timestamptz IS NULL OR (effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2)))
        ORDER BY variant_id, effective_from`,
      [id, q.at ?? null],
    );
    return rows.map((r) => ({ ...r, unitPrice: normalize(r.unitPrice) }));
  });
};
