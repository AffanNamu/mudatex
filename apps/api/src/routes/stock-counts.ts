import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authorize, grantsFor } from '../auth/authorize.js';
import type { Db } from '../db.js';
import { fromScaled, normalize, toScaled } from '../domain/decimal.js';
import { parseQuantity, QuantityError } from '../domain/quantity.js';
import { invalid } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { audit, checkLot, loadStockLocation, loadVariant, quantityField, scopeFilter, uuid } from '../inventory/common.js';

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const countBody = z.object({
  locationId: uuid,
  note: z.string().trim().max(500).optional(),
  /** When the shelf was counted. A phone that was offline sends the real time; the books are compared as of then. */
  countedAt: z.string().datetime().optional(),
  lines: z.array(z.object({ variantId: uuid, lotId: uuid.optional(), counted: quantityField })).min(1).max(300),
});

interface Difference { variantId: string; sku: string; productName: string; lotId: string | null; lotCode: string | null; counted: string; expected: string; delta: string }

export const stockCountRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  /**
   * Submits what was counted. For each line the server works out what the books said at the time of counting (today's
   * balance less everything posted since), and any difference becomes one pending adjustment for a second person to
   * approve. Nothing is posted to stock here.
   */
  app.post('/inventory/counts', async (req, reply) => {
    const body = countBody.parse(req.body);
    const { actor } = req;
    const now = Date.now();
    const at = body.countedAt ? Math.min(Date.parse(body.countedAt), now) : now;
    if (now - at > MAX_AGE_MS) throw invalid('This count is more than 7 days old. Count again.');
    const countedAt = new Date(at).toISOString();

    return idempotent(db, req, reply, async (tx) => {
      await authorize(tx, actor, 'inventory.adjust', { kind: 'location', locationId: body.locationId });
      const location = await loadStockLocation(tx, actor.organizationId, body.locationId);

      const seen = new Set<string>();
      const diffs: Difference[] = [];
      const counted: { variantId: string; lotId: string | null; counted: string; expected: string }[] = [];
      for (const line of body.lines) {
        const dup = `${line.variantId}/${line.lotId ?? ''}`;
        if (seen.has(dup)) throw invalid('Each product (and lot or roll) can appear once in a count');
        seen.add(dup);
        const variant = await loadVariant(tx, actor.organizationId, line.variantId);
        const lotId = await checkLot(tx, actor.organizationId, variant, line.lotId, { allowQuarantined: true });
        let qty: string;
        try { qty = parseQuantity(line.counted, variant.baseUnit); } catch (e) { if (e instanceof QuantityError) throw invalid(e.message); throw e; }
        const { rows } = await tx.query<{ expected: string }>(
          `SELECT COALESCE((SELECT quantity FROM stock_balances WHERE organization_id = $1 AND location_id = $2 AND variant_id = $3
                              AND lot_id IS NOT DISTINCT FROM $4::uuid AND state = 'on_hand'), 0)
                - COALESCE((SELECT sum(quantity) FROM stock_movements WHERE organization_id = $1 AND location_id = $2 AND variant_id = $3
                              AND lot_id IS NOT DISTINCT FROM $4::uuid AND state = 'on_hand' AND occurred_at > $5::timestamptz), 0) AS expected`,
          [actor.organizationId, location.id, variant.id, lotId, countedAt],
        );
        const expected = normalize(rows[0]!.expected);
        counted.push({ variantId: variant.id, lotId, counted: normalize(qty), expected });
        const delta = toScaled(qty) - toScaled(expected);
        if (delta !== 0n) diffs.push({ variantId: variant.id, sku: variant.sku, productName: '', lotId, lotCode: null, counted: normalize(qty), expected, delta: fromScaled(delta) });
      }

      let adjustmentId: string | null = null;
      if (diffs.length) {
        const reason = `Stock count of ${countedAt.slice(0, 10)}${body.note ? ` – ${body.note}` : ''}`;
        const a = await tx.query<{ id: string }>(
          'INSERT INTO stock_adjustments (organization_id, location_id, reason, requested_by) VALUES ($1, $2, $3, $4) RETURNING id',
          [actor.organizationId, location.id, reason, actor.userId],
        );
        adjustmentId = a.rows[0]!.id;
        for (const d of diffs) {
          await tx.query('INSERT INTO stock_adjustment_lines (adjustment_id, variant_id, lot_id, delta) VALUES ($1,$2,$3,$4)', [adjustmentId, d.variantId, d.lotId, d.delta]);
        }
        await audit(tx, req, 'inventory.adjustment_request', 'adjustment', adjustmentId, { reason, fromCount: true });
      }

      const c = await tx.query<{ id: string }>(
        'INSERT INTO stock_counts (organization_id, location_id, counted_by, counted_at, note, adjustment_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [actor.organizationId, location.id, actor.userId, countedAt, body.note ?? null, adjustmentId],
      );
      const id = c.rows[0]!.id;
      for (const [i, l] of counted.entries()) {
        await tx.query('INSERT INTO stock_count_lines (count_id, seq, variant_id, lot_id, counted, expected) VALUES ($1,$2,$3,$4,$5,$6)', [id, i + 1, l.variantId, l.lotId, l.counted, l.expected]);
      }
      await audit(tx, req, 'inventory.count', 'stock_count', id, { locationId: location.id, lines: counted.length, differences: diffs.length });

      // Labels for the answer.
      const labels = await tx.query<{ id: string; name: string }>(
        'SELECT v.id, p.name FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ANY($1::uuid[])',
        [diffs.map((d) => d.variantId)],
      );
      const lots = await tx.query<{ id: string; code: string }>('SELECT id, code FROM stock_lots WHERE id = ANY($1::uuid[])', [diffs.map((d) => d.lotId).filter(Boolean)]);
      for (const d of diffs) {
        d.productName = labels.rows.find((r) => r.id === d.variantId)?.name ?? '';
        d.lotCode = lots.rows.find((r) => r.id === d.lotId)?.code ?? null;
      }
      return { status: 201, body: { id, countedAt, adjustmentId, matched: counted.length - diffs.length, differences: diffs } };
    });
  });

  app.get('/inventory/counts', async (req) => {
    const q = z.object({ locationId: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
    const grants = await grantsFor(db, req.actor, 'inventory.read');
    const scope = scopeFilter(grants, 4);
    const { rows } = await db.query(
      `SELECT c.id, c.location_id AS "locationId", l.name AS "locationName", c.counted_at AS "countedAt", c.note, c.adjustment_id AS "adjustmentId",
              a.status AS "adjustmentStatus", u.display_name AS "countedBy",
              (SELECT count(*)::int FROM stock_count_lines x WHERE x.count_id = c.id) AS lines
         FROM stock_counts c JOIN locations l ON l.id = c.location_id JOIN users u ON u.id = c.counted_by
         LEFT JOIN stock_adjustments a ON a.id = c.adjustment_id
        WHERE c.organization_id = $1 AND ($2::uuid IS NULL OR c.location_id = $2) AND ${scope.clause}
        ORDER BY c.created_at DESC, c.id LIMIT $3`,
      [req.actor.organizationId, q.locationId ?? null, q.limit, ...scope.params],
    );
    return rows;
  });

  /**
   * Everything a phone needs to count, look up and receive at one place while the connection comes and goes: each active
   * product with its barcodes and what is on the shelf. Capped so a very large catalogue cannot produce an unbounded reply.
   */
  app.get('/inventory/count-sheet', async (req) => {
    const q = z.object({ locationId: uuid }).parse(req.query);
    await authorize(db, req.actor, 'inventory.read', { kind: 'location', locationId: q.locationId });
    const org = req.actor.organizationId;
    const LIMIT = 4000;
    const items = await db.query<{ variantId: string; sku: string; productName: string; tracking: string; unit: string; unitKind: string; precision: number; barcodes: string[] }>(
      `SELECT v.id AS "variantId", v.sku, p.name AS "productName", v.tracking, u.code AS unit, u.kind AS "unitKind", u.precision,
              COALESCE((SELECT array_agg(b.barcode ORDER BY b.barcode) FROM variant_barcodes b WHERE b.variant_id = v.id), '{}') AS barcodes
         FROM product_variants v JOIN products p ON p.id = v.product_id JOIN units u ON u.id = p.base_unit_id
        WHERE v.organization_id = $1 AND v.status = 'active'
        ORDER BY p.name, v.sku LIMIT $2`,
      [org, LIMIT + 1],
    );
    const bal = await db.query<{ variantId: string; lotId: string | null; lotCode: string | null; quantity: string; reserved: string; hold: string | null }>(
      `SELECT b.variant_id AS "variantId", b.lot_id AS "lotId", sl.code AS "lotCode", b.quantity, b.reserved, sl.hold_status AS hold
         FROM stock_balances b LEFT JOIN stock_lots sl ON sl.id = b.lot_id
        WHERE b.organization_id = $1 AND b.location_id = $2 AND b.state = 'on_hand' AND (b.quantity <> 0 OR b.reserved <> 0)
        ORDER BY sl.code NULLS FIRST`,
      [org, q.locationId],
    );
    const byVariant = new Map<string, unknown[]>();
    for (const b of bal.rows) {
      const list = byVariant.get(b.variantId) ?? [];
      list.push({
        lotId: b.lotId, lotCode: b.lotCode, quarantined: b.hold === 'quarantined', quantity: normalize(b.quantity), reserved: normalize(b.reserved),
        available: fromScaled(toScaled(b.quantity) - toScaled(b.reserved)),
      });
      byVariant.set(b.variantId, list);
    }
    const truncated = items.rows.length > LIMIT;
    return {
      locationId: q.locationId,
      generatedAt: new Date().toISOString(),
      truncated,
      items: items.rows.slice(0, LIMIT).map((i) => ({ ...i, balances: byVariant.get(i.variantId) ?? [] })),
    };
  });

  /**
   * Finds products for the phone: by scanned barcode or SKU (exact), or by typing part of a name or SKU, and shows what
   * is on the shelf at the chosen location. Nothing here needs catalogue rights; it only shows labels and quantities.
   */
  app.get('/inventory/lookup', async (req) => {
    const q = z.object({ code: z.string().trim().min(1).max(100).optional(), q: z.string().trim().min(2).max(100).optional(), locationId: uuid }).parse(req.query);
    if (!q.code && !q.q) throw invalid('Give a code to scan or some text to search');
    await authorize(db, req.actor, 'inventory.read', { kind: 'location', locationId: q.locationId });
    const org = req.actor.organizationId;
    const base = `SELECT v.id AS "variantId", v.sku, p.name AS "productName", v.tracking, u.code AS unit, u.kind AS "unitKind", u.precision,
                         (SELECT barcode FROM variant_barcodes b WHERE b.variant_id = v.id ORDER BY barcode LIMIT 1) AS barcode
                    FROM product_variants v JOIN products p ON p.id = v.product_id JOIN units u ON u.id = p.base_unit_id`;
    const found = q.code
      ? await db.query(
          `${base} WHERE v.organization_id = $1 AND v.status = 'active'
              AND (lower(v.sku) = lower($2) OR v.id IN (SELECT variant_id FROM variant_barcodes WHERE organization_id = $1 AND barcode = $2))
            ORDER BY v.sku LIMIT 5`,
          [org, q.code],
        )
      : await db.query(
          `${base} WHERE v.organization_id = $1 AND v.status = 'active' AND (p.name ILIKE $2 OR v.sku ILIKE $2)
            ORDER BY p.name, v.sku LIMIT 20`,
          [org, `%${q.q!.replace(/[\\%_]/g, '\\$&')}%`],
        );
    const ids = found.rows.map((r) => r.variantId as string);
    const bal = await db.query<{ variantId: string; lotId: string | null; lotCode: string | null; quantity: string; reserved: string; hold: string | null }>(
      `SELECT b.variant_id AS "variantId", b.lot_id AS "lotId", sl.code AS "lotCode", b.quantity, b.reserved, sl.hold_status AS hold
         FROM stock_balances b LEFT JOIN stock_lots sl ON sl.id = b.lot_id
        WHERE b.organization_id = $1 AND b.location_id = $2 AND b.state = 'on_hand' AND b.variant_id = ANY($3::uuid[])
        ORDER BY sl.code NULLS FIRST`,
      [org, q.locationId, ids],
    );
    return found.rows.map((r) => ({
      ...r,
      balances: bal.rows.filter((b) => b.variantId === r.variantId).map((b) => ({
        lotId: b.lotId, lotCode: b.lotCode, quarantined: b.hold === 'quarantined', quantity: normalize(b.quantity), reserved: normalize(b.reserved),
        available: fromScaled(toScaled(b.quantity) - toScaled(b.reserved)),
      })),
    }));
  });
};
