import type { Db } from '../db.js';
import { normalize } from '../domain/decimal.js';
import { priceLine } from '../domain/money.js';
import { invalid, notFound } from '../errors.js';
import { loadI18n, orNothing, type I18n } from './translations.js';

export interface Storefront {
  id: string;
  organizationId: string;
  legalEntityId: string;
  slug: string;
  name: string;
  priceListId: string;
  currency: string;
  minorUnit: number;
  stockLocationIds: string[];
  status: string;
  tagline: string | null;
  contact: Record<string, unknown>;
  siteUrl: string | null;
}

/** What the public may see is capped so the site never leaks exact stock levels. */
export const AVAILABILITY_CAP = 100;

export async function loadLiveStorefront(db: Db, slug: string): Promise<Storefront> {
  const { rows } = await db.query(
    `SELECT s.id, s.organization_id AS "organizationId", s.legal_entity_id AS "legalEntityId", s.slug, s.name,
            s.price_list_id AS "priceListId", s.currency, c.minor_unit AS "minorUnit", s.stock_location_ids AS "stockLocationIds",
            s.status, s.tagline, s.contact, s.site_url AS "siteUrl"
       FROM storefronts s JOIN currencies c ON c.code = s.currency
      WHERE s.slug = $1 AND s.status = 'live'`,
    [slug],
  );
  if (!rows[0]) throw notFound('Store');
  return rows[0] as Storefront;
}

interface VariantRow {
  variantId: string;
  productId: string;
  sku: string;
  attributes: Record<string, unknown>;
  tracking: string;
  unitPrice: string;
  taxCode: string | null;
  taxRate: string | null;
  taxInclusive: boolean | null;
}

/** Sellable variants of the given products with their current price on the storefront's price list. */
async function pricedVariants(db: Db, sf: Storefront, productIds: string[]): Promise<VariantRow[]> {
  if (!productIds.length) return [];
  const { rows } = await db.query<VariantRow>(
    `SELECT v.id AS "variantId", v.product_id AS "productId", v.sku, v.attributes, v.tracking,
            i.unit_price AS "unitPrice", t.code AS "taxCode", t.rate AS "taxRate", t.price_inclusive AS "taxInclusive"
       FROM product_variants v
       JOIN price_list_items i ON i.variant_id = v.id AND i.price_list_id = $2
            AND i.effective_from <= now() AND (i.effective_to IS NULL OR i.effective_to > now())
       LEFT JOIN tax_codes t ON t.id = i.tax_code_id
      WHERE v.organization_id = $1 AND v.product_id = ANY($3::uuid[]) AND v.status = 'active'
      ORDER BY v.sku`,
    [sf.organizationId, sf.priceListId, productIds],
  );
  return rows;
}

/** Sellable quantity per variant: on hand less reserved, at the storefront's locations, excluding quarantined lots. */
export async function availability(db: Db, sf: Storefront, variantIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!variantIds.length) return out;
  const { rows } = await db.query<{ variantId: string; available: string }>(
    `SELECT b.variant_id AS "variantId", SUM(b.quantity - b.reserved) AS available
       FROM stock_balances b LEFT JOIN stock_lots l ON l.id = b.lot_id
      WHERE b.organization_id = $1 AND b.state = 'on_hand' AND b.location_id = ANY($2::uuid[])
        AND b.variant_id = ANY($3::uuid[]) AND (l.id IS NULL OR l.hold_status = 'released')
      GROUP BY b.variant_id`,
    [sf.organizationId, sf.stockLocationIds, variantIds],
  );
  for (const r of rows) out.set(r.variantId, normalize(r.available));
  return out;
}

/** The price a shopper pays for one base unit, tax included, in minor units. */
export function displayPrice(sf: Storefront, v: Pick<VariantRow, 'unitPrice' | 'taxCode' | 'taxRate' | 'taxInclusive'>): bigint {
  const tax = v.taxCode ? { code: v.taxCode, rate: normalize(v.taxRate!), inclusive: v.taxInclusive! } : null;
  return priceLine({ quantity: '1', unitPrice: normalize(v.unitPrice), minorUnit: sf.minorUnit, tax }).total;
}

const capped = (available: string | undefined) => {
  const n = Number(available ?? '0');
  return n > AVAILABILITY_CAP ? AVAILABILITY_CAP : Math.max(0, Math.floor(n * 100) / 100);
};

export interface ProductCard {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  images: string[];
  badges: string[];
  department: { slug: string; name: string; i18n?: I18n } | null;
  i18n?: I18n;
  priceMinor: number;
  currency: string;
  inStock: boolean;
}

/** Department translations of a storefront by department slug (there are only a handful of departments). */
export async function departmentI18nBySlug(db: Db, sf: Storefront): Promise<Map<string, I18n>> {
  const { rows } = await db.query<{ id: string; slug: string }>('SELECT id, slug FROM storefront_departments WHERE storefront_id = $1', [sf.id]);
  const byId = await loadI18n(db, sf.id, 'department', rows.map((r) => r.id));
  const out = new Map<string, I18n>();
  for (const r of rows) { const i = orNothing(byId.get(r.id)); if (i) out.set(r.slug, i); }
  return out;
}

/** Cards for already-selected storefront products, in the order given. */
export async function cardsFor(db: Db, sf: Storefront, rows: { id: string; productId: string; slug: string; title: string; brand: string | null; images: unknown; badges: string[]; departmentSlug: string | null; departmentName: string | null }[]): Promise<ProductCard[]> {
  const variants = await pricedVariants(db, sf, [...new Set(rows.map((r) => r.productId))]);
  const stock = await availability(db, sf, variants.map((v) => v.variantId));
  const words = await loadI18n(db, sf.id, 'product', rows.map((r) => r.id));
  const deptWords = await departmentI18nBySlug(db, sf);
  return rows.map((r) => {
    const mine = variants.filter((v) => v.productId === r.productId);
    const prices = mine.map((v) => displayPrice(sf, v));
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      brand: r.brand,
      images: (r.images as string[]) ?? [],
      badges: r.badges,
      department: r.departmentSlug ? { slug: r.departmentSlug, name: r.departmentName!, i18n: deptWords.get(r.departmentSlug) } : null,
      i18n: orNothing(words.get(r.id)),
      priceMinor: Number(prices.reduce((a, b) => (b < a ? b : a), prices[0] ?? 0n)),
      currency: sf.currency,
      inStock: mine.some((v) => Number(stock.get(v.variantId) ?? '0') > 0),
    };
  });
}

export async function productDetail(db: Db, sf: Storefront, productSlug: string) {
  const { rows } = await db.query(
    `SELECT sp.id, sp.product_id AS "productId", sp.slug, sp.title, sp.description, sp.brand, sp.images, sp.badges,
            d.slug AS "departmentSlug", d.name AS "departmentName", p.base_unit_id AS "baseUnitId", p.attributes, p.category
       FROM storefront_products sp
       JOIN products p ON p.id = sp.product_id AND p.status = 'active'
       LEFT JOIN storefront_departments d ON d.id = sp.department_id
      WHERE sp.storefront_id = $1 AND sp.slug = $2 AND sp.published`,
    [sf.id, productSlug],
  );
  const sp = rows[0];
  if (!sp) throw notFound('Product');
  const variants = await pricedVariants(db, sf, [sp.productId]);
  if (!variants.length) throw notFound('Product');
  const stock = await availability(db, sf, variants.map((v) => v.variantId));
  const units = await db.query(
    `SELECT code, name, kind, precision FROM units WHERE id = $1`,
    [sp.baseUnitId],
  );
  const conversions = await db.query(
    `SELECT f.code AS "fromCode", f.name AS "fromName", t.code AS "toCode", c.factor
       FROM product_unit_conversions c JOIN units f ON f.id = c.from_unit_id JOIN units t ON t.id = c.to_unit_id
      WHERE c.product_id = $1`,
    [sp.productId],
  );
  const rating = await db.query<{ average: string | null; count: number }>(
    `SELECT round(avg(rating)::numeric, 1) AS average, count(*)::int AS count FROM product_reviews WHERE storefront_product_id = $1 AND status = 'published'`,
    [sp.id],
  );
  const words = (await loadI18n(db, sf.id, 'product', [sp.id])).get(sp.id);
  const deptWords = sp.departmentSlug ? (await departmentI18nBySlug(db, sf)).get(sp.departmentSlug) : undefined;
  return {
    id: sp.id,
    i18n: orNothing(words),
    rating: { average: rating.rows[0]!.average === null ? null : Number(rating.rows[0]!.average), count: rating.rows[0]!.count },
    slug: sp.slug,
    title: sp.title,
    description: sp.description,
    brand: sp.brand,
    images: sp.images as string[],
    badges: sp.badges as string[],
    department: sp.departmentSlug ? { slug: sp.departmentSlug, name: sp.departmentName, i18n: deptWords } : null,
    category: sp.category,
    attributes: sp.attributes,
    unit: units.rows[0],
    conversions: conversions.rows.map((c) => ({ ...c, factor: normalize(c.factor, 8) })),
    currency: sf.currency,
    variants: variants.map((v) => {
      const available = stock.get(v.variantId);
      return {
        variantId: v.variantId,
        sku: v.sku,
        attributes: v.attributes,
        unitPrice: normalize(v.unitPrice),
        priceMinor: Number(displayPrice(sf, v)),
        taxInclusive: v.taxInclusive ?? false,
        available: capped(available),
        inStock: Number(available ?? '0') > 0,
      };
    }),
  };
}

export interface DeliveryQuote {
  zoneId: string;
  zone: string;
  feeMinor: number;
  standardFeeMinor: number;
  freeOverMinor: number | null;
  currency: string;
  etaDays: { min: number; max: number };
}

/** Delivery fee for a place and basket value. The most specific zone wins (a named state beats a whole country). */
export async function quoteDelivery(db: Pick<Db, 'query'>, sf: Storefront, countryCode: string, state: string, subtotalMinor: number | bigint): Promise<DeliveryQuote> {
  const { rows } = await db.query<{ id: string; name: string; fee: string; free: string | null; min: number; max: number }>(
    `SELECT id, name, fee_minor AS fee, free_over_minor AS free, eta_days_min AS min, eta_days_max AS max
       FROM delivery_zones
      WHERE storefront_id = $1 AND active AND country_code = upper($2)
        AND (cardinality(states) = 0 OR lower($3) = ANY(states))
      ORDER BY (cardinality(states) = 0), fee_minor LIMIT 1`,
    [sf.id, countryCode, state],
  );
  const zone = rows[0];
  if (!zone) throw invalid('We do not deliver to that location yet', { key: 'err.delivery.none' });
  const free = zone.free !== null && BigInt(subtotalMinor) >= BigInt(zone.free);
  return {
    zoneId: zone.id,
    zone: zone.name,
    feeMinor: free ? 0 : Number(zone.fee),
    standardFeeMinor: Number(zone.fee),
    freeOverMinor: zone.free === null ? null : Number(zone.free),
    currency: sf.currency,
    etaDays: { min: zone.min, max: zone.max },
  };
}
