import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, grantsFor } from '../auth/authorize.js';
import { withTx, type Db, type Tx } from '../db.js';
import { nextDocumentNumber } from '../documents.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';
import { publishEvent } from '../events/publish.js';
import { idempotent } from '../idempotency.js';
import { audit, uuid } from '../inventory/common.js';
import type { Actor } from '../auth/authorize.js';
import type { Storefront } from '../shop/catalog.js';
import { checkValidUntil, MAX_QUOTE_LINES, priceQuoteLines, quoteLineBody, readQuote, saveQuoteLines } from '../trade/quotes.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const createBody = z.object({
  tradeAccountId: uuid,
  validUntil: date,
  note: z.string().trim().max(1000).optional(),
  lines: z.array(quoteLineBody).min(1).max(MAX_QUOTE_LINES),
});
const updateBody = z.object({
  validUntil: date.optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(quoteLineBody).min(1).max(MAX_QUOTE_LINES).optional(),
});

/** Quotes for trade buyers: drafted and priced by staff, sent to the buyer, accepted in the shop. */
export const quoteRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  async function mayUndercut(tx: Tx | Db, actor: Actor, legalEntityId: string) {
    try { await authorize(tx, actor, 'quotes.price.override', { kind: 'legal_entity', legalEntityId }); return true; } catch (e) { if (e instanceof Error && 'status' in e && (e as { status: number }).status === 403) return false; throw e; }
  }

  /** The storefront and trade terms a quote for this business is priced from. */
  async function context(tx: Tx, organizationId: string, tradeAccountId: string) {
    const { rows } = await tx.query<{ id: string; status: string; price_list_id: string | null; customer_id: string; sid: string; legal_entity_id: string; slug: string; name: string; currency: string; minor_unit: number; stock: string[] }>(
      `SELECT t.id, t.status, t.price_list_id, t.customer_id, s.id AS sid, s.legal_entity_id, s.slug, s.name, s.currency, c.minor_unit, s.stock_location_ids AS stock
         FROM trade_accounts t JOIN storefronts s ON s.id = t.storefront_id JOIN currencies c ON c.code = s.currency
        WHERE t.id = $1 AND t.organization_id = $2 FOR UPDATE OF t`,
      [tradeAccountId, organizationId],
    );
    const r = rows[0];
    if (!r) throw notFound('Trade account');
    const sf = { id: r.sid, organizationId, legalEntityId: r.legal_entity_id, slug: r.slug, name: r.name, priceListId: r.price_list_id ?? '', currency: r.currency, minorUnit: r.minor_unit, stockLocationIds: r.stock } as Storefront;
    return { trade: r, sf };
  }

  app.post('/quotes', async (req, reply) => {
    const body = createBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const { trade, sf } = await context(tx, actor.organizationId, body.tradeAccountId);
      await authorize(tx, actor, 'quotes.manage', { kind: 'legal_entity', legalEntityId: sf.legalEntityId });
      if (trade.status !== 'approved' || !trade.price_list_id) throw conflict('Quotes can only be made for businesses with an approved trade account');
      checkValidUntil(body.validUntil);
      const priced = await priceQuoteLines(tx, sf, trade.price_list_id, body.lines, await mayUndercut(tx, actor, sf.legalEntityId));
      const no = await nextDocumentNumber(tx, actor.organizationId, sf.legalEntityId, 'quote', 'QT');
      const q = await tx.query<{ id: string }>(
        `INSERT INTO quotes (organization_id, legal_entity_id, storefront_id, trade_account_id, customer_id, quote_no, currency, valid_until, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [actor.organizationId, sf.legalEntityId, sf.id, trade.id, trade.customer_id, no, sf.currency, body.validUntil, body.note ?? null, actor.userId],
      );
      await saveQuoteLines(tx, q.rows[0]!.id, priced);
      await audit(tx, req, 'quote.create', 'quote', q.rows[0]!.id, { quoteNo: no, tradeAccountId: trade.id, lines: body.lines });
      return { status: 201, body: await readQuote(tx, { id: q.rows[0]!.id, organizationId: actor.organizationId }) };
    });
  });

  /** The businesses a person may quote for: approved trade accounts in their scope. */
  app.get('/quotes/accounts', async (req) => {
    const grants = await grantsFor(db, req.actor, 'quotes.manage');
    const { rows } = await db.query(
      `SELECT t.id, t.business_name AS "businessName", s.currency, s.legal_entity_id AS "legalEntityId", e.country_code AS "countryCode"
         FROM trade_accounts t JOIN storefronts s ON s.id = t.storefront_id JOIN legal_entities e ON e.id = s.legal_entity_id
        WHERE t.organization_id = $1 AND t.status = 'approved' ORDER BY t.business_name`,
      [req.actor.organizationId],
    );
    return rows
      .filter((r) => grants.group || grants.countries.has(r.countryCode.trim()) || grants.legalEntities.has(r.legalEntityId))
      .map(({ countryCode: _c, legalEntityId: _l, ...r }) => r);
  });

  app.get('/quotes', async (req) => {
    const q = z.object({ status: z.enum(['draft', 'sent', 'accepted', 'declined', 'cancelled', 'expired']).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
    const grants = await grantsFor(db, req.actor, 'quotes.manage');
    const { rows } = await db.query(
      `SELECT * FROM (
         SELECT q.id, q.quote_no AS "quoteNo", CASE WHEN q.status = 'sent' AND q.valid_until < CURRENT_DATE THEN 'expired' ELSE q.status END AS status,
                q.currency, q.subtotal_minor::float8 AS "totalMinor", to_char(q.valid_until, 'YYYY-MM-DD') AS "validUntil", q.created_at AS "createdAt", t.business_name AS "businessName",
                (SELECT order_no FROM sales_orders WHERE id = q.order_id) AS "orderNo", q.legal_entity_id AS "legalEntityId", e.country_code AS "countryCode",
                (SELECT count(*)::int FROM quote_lines l WHERE l.quote_id = q.id) AS "lineCount"
           FROM quotes q JOIN trade_accounts t ON t.id = q.trade_account_id JOIN legal_entities e ON e.id = q.legal_entity_id
          WHERE q.organization_id = $1) x
        WHERE ($2::text IS NULL OR status = $2) ORDER BY "createdAt" DESC LIMIT $3`,
      [req.actor.organizationId, q.status ?? null, q.limit],
    );
    return rows
      .filter((r) => grants.group || grants.countries.has(r.countryCode.trim()) || grants.legalEntities.has(r.legalEntityId))
      .map(({ countryCode: _c, legalEntityId: _l, ...r }) => r);
  });

  app.get('/quotes/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = await readQuote(db, { id, organizationId: req.actor.organizationId });
    await authorize(db, req.actor, 'quotes.manage', { kind: 'legal_entity', legalEntityId: q.legalEntityId });
    return q;
  });

  app.put('/quotes/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = updateBody.parse(req.body);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const found = await tx.query<{ status: string; trade_account_id: string; legal_entity_id: string }>('SELECT status, trade_account_id, legal_entity_id FROM quotes WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, actor.organizationId]);
      const row = found.rows[0];
      if (!row) throw notFound('Quote');
      await authorize(tx, actor, 'quotes.manage', { kind: 'legal_entity', legalEntityId: row.legal_entity_id });
      if (row.status !== 'draft') throw conflict('Only a draft quote can be changed; cancel it and make a new one');
      if (body.validUntil) { checkValidUntil(body.validUntil); await tx.query('UPDATE quotes SET valid_until = $2 WHERE id = $1', [id, body.validUntil]); }
      if (body.note !== undefined) await tx.query('UPDATE quotes SET note = $2 WHERE id = $1', [id, body.note]);
      if (body.lines) {
        const { trade, sf } = await context(tx, actor.organizationId, row.trade_account_id);
        if (!trade.price_list_id) throw conflict('This business has no trade price list');
        await saveQuoteLines(tx, id, await priceQuoteLines(tx, sf, trade.price_list_id, body.lines, await mayUndercut(tx, actor, sf.legalEntityId)));
      }
      await audit(tx, req, 'quote.update', 'quote', id, body);
      return { status: 200, body: await readQuote(tx, { id, organizationId: actor.organizationId }) };
    });
  });

  app.post('/quotes/:id/send', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const found = await tx.query<{ status: string; trade_account_id: string; legal_entity_id: string; created_by: string; expired: boolean }>(
        'SELECT status, trade_account_id, legal_entity_id, created_by, valid_until < CURRENT_DATE AS expired FROM quotes WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, actor.organizationId]);
      const row = found.rows[0];
      if (!row) throw notFound('Quote');
      await authorize(tx, actor, 'quotes.manage', { kind: 'legal_entity', legalEntityId: row.legal_entity_id });
      if (row.status !== 'draft') throw conflict(`This quote is already ${row.status}`);
      if (row.expired) throw invalid('This quote is past its valid-until date; change the date first');
      const lines = await tx.query('SELECT 1 FROM quote_lines WHERE quote_id = $1 LIMIT 1', [id]);
      if (!lines.rowCount) throw invalid('A quote needs at least one line');
      const trade = await tx.query<{ status: string }>('SELECT status FROM trade_accounts WHERE id = $1', [row.trade_account_id]);
      if (trade.rows[0]?.status !== 'approved') throw conflict('This business\'s trade account is not approved right now');
      await tx.query(`UPDATE quotes SET status = 'sent', sent_at = now() WHERE id = $1`, [id]);
      await publishEvent(tx, { organizationId: actor.organizationId, type: 'quote.send', aggregateType: 'quote', aggregateId: id, actorUserId: actor.userId, requestId: req.id });
      await audit(tx, req, 'quote.send', 'quote', id);
      return { status: 200, body: await readQuote(tx, { id, organizationId: actor.organizationId }) };
    });
  });

  app.post('/quotes/:id/cancel', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { actor } = req;
    return idempotent(db, req, reply, async (tx) => {
      const found = await tx.query<{ status: string; legal_entity_id: string }>('SELECT status, legal_entity_id FROM quotes WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, actor.organizationId]);
      const row = found.rows[0];
      if (!row) throw notFound('Quote');
      await authorize(tx, actor, 'quotes.manage', { kind: 'legal_entity', legalEntityId: row.legal_entity_id });
      if (!['draft', 'sent'].includes(row.status)) throw conflict(`A ${row.status} quote cannot be cancelled`);
      await tx.query(`UPDATE quotes SET status = 'cancelled', decided_at = now() WHERE id = $1`, [id]);
      await audit(tx, req, 'quote.cancel', 'quote', id);
      return { status: 200, body: await readQuote(tx, { id, organizationId: actor.organizationId }) };
    });
  });
};
