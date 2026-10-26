import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { grantsFor, type Grants } from '../auth/authorize.js';
import type { Db } from '../db.js';
import { normalize } from '../domain/decimal.js';
import { scopeFilter } from '../inventory/common.js';

/** The same rule as everywhere else: what a person may see is what their grants cover. Money is never added across currencies. */
const entityScope = (g: Grants, n: number) => ({
  clause: `($${n}::boolean OR e.country_code::text = ANY($${n + 1}::text[]) OR e.id = ANY($${n + 2}::uuid[]))`,
  params: [g.group, [...g.countries], [...g.legalEntities]] as unknown[],
});
const anyGrant = (g: Grants) => g.group || g.countries.size > 0 || g.legalEntities.size > 0 || g.locations.size > 0;
const entityGrant = (g: Grants) => g.group || g.countries.size > 0 || g.legalEntities.size > 0;

const LIVE_ORDER = `o.status NOT IN ('pending_payment', 'cancelled', 'expired')`;

interface Day { pos: number; online: number; posSales: number; onlineOrders: number }
interface Product { sku: string; name: string; quantity: number; revenueMinor: number }

export const reportRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/reports/overview', async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(366).default(30), lowStockAt: z.coerce.number().min(0).max(100000).default(10) }).parse(req.query);
    const org = req.actor.organizationId;
    const [posGrants, ordGrants, invGrants, enqGrants, revGrants, tradeGrants] = await Promise.all(
      (['pos.read', 'orders.read', 'inventory.read', 'enquiries.manage', 'reviews.moderate', 'trade.manage'] as const).map((p) => grantsFor(db, req.actor, p)),
    ) as [Grants, Grants, Grants, Grants, Grants, Grants];
    const hasPos = anyGrant(posGrants);
    const hasOrders = entityGrant(ordGrants);
    const since = new Date(Date.now() - q.days * 86_400_000);
    const posScope = scopeFilter(posGrants, 3);
    const ordScope = entityScope(ordGrants, 3);

    // Sales by day, currency and channel. A day follows the shop's own clock.
    const pos = hasPos ? (await db.query<{ currency: string; minor_unit: number; day: string; total: string; sales: string }>(
      `SELECT s.currency, s.minor_unit, ((s.completed_at AT TIME ZONE l.timezone)::date)::text AS day, sum(s.total_minor) AS total, count(*) AS sales
         FROM pos_sales s JOIN locations l ON l.id = s.location_id
        WHERE s.organization_id = $1 AND s.status = 'completed' AND s.completed_at >= $2 AND ${posScope.clause}
        GROUP BY 1, 2, 3`,
      [org, since, ...posScope.params],
    )).rows : [];
    const online = hasOrders ? (await db.query<{ currency: string; minor_unit: number; day: string; total: string; sales: string }>(
      `SELECT o.currency, cu.minor_unit, ((COALESCE(o.paid_at, o.placed_at) AT TIME ZONE COALESCE(l.timezone, 'UTC'))::date)::text AS day, sum(o.total_minor) AS total, count(*) AS sales
         FROM sales_orders o JOIN legal_entities e ON e.id = o.legal_entity_id JOIN currencies cu ON cu.code = o.currency
         JOIN storefronts st ON st.id = o.storefront_id LEFT JOIN locations l ON l.id = st.stock_location_ids[1]
        WHERE o.organization_id = $1 AND ${LIVE_ORDER} AND o.placed_at >= $2 AND ${ordScope.clause}
        GROUP BY 1, 2, 3`,
      [org, since, ...ordScope.params],
    )).rows : [];

    const currencies = new Map<string, { currency: string; minorUnit: number; days: Map<string, Day>; top: Map<string, Product> }>();
    const slot = (currency: string, minorUnit: number) => {
      const key = currency.trim();
      const c = currencies.get(key) ?? { currency: key, minorUnit, days: new Map(), top: new Map() };
      currencies.set(key, c);
      return c;
    };
    const day = (currency: string, minorUnit: number, date: string) => {
      const c = slot(currency, minorUnit);
      const d = c.days.get(date) ?? { pos: 0, online: 0, posSales: 0, onlineOrders: 0 };
      c.days.set(date, d);
      return d;
    };
    for (const r of pos) { const d = day(r.currency, r.minor_unit, r.day); d.pos += Number(r.total); d.posSales += Number(r.sales); }
    for (const r of online) { const d = day(r.currency, r.minor_unit, r.day); d.online += Number(r.total); d.onlineOrders += Number(r.sales); }

    // Best sellers by revenue, per currency, from both channels.
    const addTop = (rows: { currency: string; sku: string; name: string; quantity: string; revenue: string }[]) => {
      for (const r of rows) {
        const c = currencies.get(r.currency.trim());
        if (!c) continue;
        const p = c.top.get(r.sku) ?? { sku: r.sku, name: r.name, quantity: 0, revenueMinor: 0 };
        p.quantity += Number(r.quantity); p.revenueMinor += Number(r.revenue);
        c.top.set(r.sku, p);
      }
    };
    if (hasPos) {
      addTop((await db.query(
        `SELECT s.currency, v.sku, p.name, sum(l2.quantity) AS quantity, sum(l2.total_minor) AS revenue
           FROM pos_sale_lines l2 JOIN pos_sales s ON s.id = l2.sale_id JOIN locations l ON l.id = s.location_id
           JOIN product_variants v ON v.id = l2.variant_id JOIN products p ON p.id = v.product_id
          WHERE s.organization_id = $1 AND s.status = 'completed' AND s.completed_at >= $2 AND ${posScope.clause}
          GROUP BY 1, 2, 3`,
        [org, since, ...posScope.params],
      )).rows);
    }
    if (hasOrders) {
      addTop((await db.query(
        `SELECT o.currency, v.sku, p.name, sum(ol.quantity) AS quantity, sum(ol.total_minor) AS revenue
           FROM sales_order_lines ol JOIN sales_orders o ON o.id = ol.order_id JOIN legal_entities e ON e.id = o.legal_entity_id
           JOIN product_variants v ON v.id = ol.variant_id JOIN products p ON p.id = v.product_id
          WHERE o.organization_id = $1 AND ${LIVE_ORDER} AND o.placed_at >= $2 AND ${ordScope.clause}
          GROUP BY 1, 2, 3`,
        [org, since, ...ordScope.params],
      )).rows);
    }

    const sales = [...currencies.values()].map((c) => {
      const series = [...c.days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, d]) => ({ date, ...d }));
      const sum = (f: (d: Day) => number) => series.reduce((a, d) => a + f(d), 0);
      return {
        currency: c.currency, minorUnit: c.minorUnit, series,
        totals: { pos: sum((d) => d.pos), online: sum((d) => d.online), posSales: sum((d) => d.posSales), onlineOrders: sum((d) => d.onlineOrders) },
        topProducts: [...c.top.values()].sort((a, b) => b.revenueMinor - a.revenueMinor).slice(0, 10).map((p) => ({ ...p, quantity: Number(normalize(String(p.quantity)).replace(/\.0+$/, '')) })),
      };
    }).sort((a, b) => b.totals.pos + b.totals.online - (a.totals.pos + a.totals.online));

    // Products that are selling but running out, at the shops the person can see.
    let lowStock: { sku: string; name: string; location: string; available: number }[] = [];
    if (anyGrant(invGrants)) {
      const scope = scopeFilter(invGrants, 4);
      const recent = new Date(Date.now() - 30 * 86_400_000);
      lowStock = (await db.query(
        `SELECT v.sku, p.name, l.name AS location, sum(b.quantity - b.reserved) AS available
           FROM stock_balances b JOIN locations l ON l.id = b.location_id JOIN product_variants v ON v.id = b.variant_id JOIN products p ON p.id = v.product_id
          WHERE b.organization_id = $1 AND b.state = 'on_hand' AND ${scope.clause}
            AND (EXISTS (SELECT 1 FROM pos_sale_lines pl JOIN pos_sales ps ON ps.id = pl.sale_id WHERE pl.variant_id = v.id AND ps.location_id = b.location_id AND ps.completed_at >= $3)
              OR EXISTS (SELECT 1 FROM sales_order_lines ol JOIN sales_orders so ON so.id = ol.order_id WHERE ol.variant_id = v.id AND so.placed_at >= $3))
          GROUP BY 1, 2, 3 HAVING sum(b.quantity - b.reserved) <= $2 ORDER BY available, p.name LIMIT 15`,
        [org, q.lowStockAt, recent, ...scope.params],
      )).rows.map((r) => ({ sku: r.sku, name: r.name, location: r.location, available: Number(r.available) }));
    }

    // Things waiting for a person, only for the areas they work in.
    const count = async (sql: string, params: unknown[]) => Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);
    const attention: Record<string, number> = {};
    if (hasOrders) {
      const os = entityScope(ordGrants, 2);
      attention.ordersAwaitingPayment = await count(`SELECT count(*) AS n FROM sales_orders o JOIN legal_entities e ON e.id = o.legal_entity_id WHERE o.organization_id = $1 AND o.status = 'pending_payment' AND ${os.clause}`, [org, ...os.params]);
      attention.ordersToShip = await count(`SELECT count(*) AS n FROM sales_orders o JOIN legal_entities e ON e.id = o.legal_entity_id WHERE o.organization_id = $1 AND o.status IN ('paid', 'confirmed', 'processing') AND ${os.clause}`, [org, ...os.params]);
    }
    const entityCount = async (table: string, extra: string, g: Grants, joinSql: string) => {
      const s = entityScope(g, 2);
      return count(`SELECT count(*) AS n FROM ${table} ${joinSql} JOIN legal_entities e ON e.id = st.legal_entity_id WHERE x.organization_id = $1 AND ${extra} AND ${s.clause}`, [org, ...s.params]);
    };
    if (entityGrant(enqGrants)) attention.newEnquiries = await entityCount('enquiries x', "x.status = 'new'", enqGrants, 'JOIN storefronts st ON st.id = x.storefront_id');
    if (entityGrant(revGrants)) attention.reviewsToApprove = await entityCount('product_reviews x', "x.status = 'pending'", revGrants, 'JOIN storefront_products sp ON sp.id = x.storefront_product_id JOIN storefronts st ON st.id = sp.storefront_id');
    if (entityGrant(tradeGrants)) attention.tradeApplications = await entityCount('trade_accounts x', "x.status = 'pending'", tradeGrants, 'JOIN storefronts st ON st.id = x.storefront_id');
    if (anyGrant(invGrants)) {
      const s = scopeFilter(invGrants, 2);
      attention.offlineShortfalls = await count(`SELECT count(*) AS n FROM pos_offline_exceptions x JOIN locations l ON l.id = x.location_id WHERE x.organization_id = $1 AND x.status = 'open' AND ${s.clause}`, [org, ...s.params]);
    }

    return { days: q.days, sales, lowStock, attention };
  });
};
