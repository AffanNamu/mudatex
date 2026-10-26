import type { Db } from '../db.js';
import { normalize } from '../domain/decimal.js';
import { priceLine } from '../domain/money.js';
import { notFound } from '../errors.js';

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
}

/** What the public may see is capped so the site never leaks exact stock levels. */
export const AVAILABILITY_CAP = 100;

export async function loadLiveStorefront(db: Db, slug: string): Promise<Storefront> {
  const { rows } = await db.query(
    `SELECT s.id, s.organization_id AS "organizationId", s.legal_entity_id AS "legalEntityId", s.slug, s.name,
            s.price_list_id AS "priceListId", s.currency, c.minor_unit AS "minorUnit", s.stock_location_ids AS "stockLocationIds",
            s.status, s.tagline, s.contact
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
  department: { slug: string; name: string } | null;
  priceMinor: number;
  currency: string;
  inStock: boolean;
}

/** Cards for already-selected storefront products, in the order given. */
export async function cardsFor(db: Db, sf: Storefront, rows: { id: string; productId: string; slug: string; title: string; brand: string | null; images: unknown; badges: string[]; departmentSlug: string | null; departmentName: string | null }[]): Promise<ProductCard[]> {
  const variants = await pricedVariants(db, sf, [...new Set(rows.map((r) => r.productId))]);
  const stock = await availability(db, sf, variants.map((v) => v.variantId));
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
      department: r.departmentSlug ? { slug: r.departmentSlug, name: r.departmentName! } : null,
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
  return {
    id: sp.id,
    slug: sp.slug,
    title: sp.title,
    description: sp.description,
    brand: sp.brand,
    images: sp.images as string[],
    badges: sp.badges as string[],
    department: sp.departmentSlug ? { slug: sp.departmentSlug, name: sp.departmentName } : null,
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
