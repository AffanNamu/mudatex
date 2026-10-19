import { createHash } from 'node:crypto';
import { toNumber, normalizeTimestamp } from './scrub.js';

type Json = Record<string, unknown>;

export interface Issue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

export interface CanonicalProduct {
  sourceId: string;
  name: string;
  description: string;
  category: string;
  unitPrice: string;              // exact decimal, 4 places
  stock: number | null;           // null when the source value cannot be used
  sku: string;
  attributes: Record<string, unknown>;
  checksum: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());
const strList = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

export function checksumOf(value: unknown): string {
  const stable = (x: unknown): string => Array.isArray(x) ? `[${x.map(stable).join(',')}]`
    : x && typeof x === 'object' ? `{${Object.keys(x as Json).sort().map((k) => `${JSON.stringify(k)}:${stable((x as Json)[k])}`).join(',')}}` : JSON.stringify(x) ?? 'null';
  return createHash('sha256').update(stable(value)).digest('hex');
}

export function skuFor(sourceId: string): string {
  return `SAK-${sourceId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase() || 'X'}`;
}

/**
 * Maps one Sakash product to the Mudatex shape. A product that cannot be imported yields `product: null` and an
 * error; problems with only part of a record (for example unusable stock) import the rest and report a warning.
 */
export function mapProduct(id: string, raw: Json): { product: CanonicalProduct | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const name = str(raw.name);
  if (!name) return { product: null, issues: [{ severity: 'error', code: 'missing_name', message: 'The product has no name' }] };

  const price = toNumber(raw.price);
  if (price === null || price < 0 || price > 1e12) {
    return { product: null, issues: [{ severity: 'error', code: 'invalid_price', message: `Price ${JSON.stringify(raw.price)} is not a usable amount` }] };
  }

  let stock: number | null = null;
  const rawStock = raw.stockQuantity === undefined ? 0 : toNumber(raw.stockQuantity);
  if (rawStock === null) issues.push({ severity: 'warning', code: 'invalid_stock', message: `Stock ${JSON.stringify(raw.stockQuantity)} is not a number; no opening stock was posted` });
  else if (rawStock < 0) issues.push({ severity: 'warning', code: 'negative_stock', message: `Stock is ${rawStock}; no opening stock was posted` });
  else if (!Number.isInteger(rawStock)) issues.push({ severity: 'warning', code: 'fractional_stock', message: `Stock ${rawStock} is not a whole number of pieces; no opening stock was posted` });
  else stock = rawStock;
  if (raw.inStock === false && stock !== null && stock > 0) issues.push({ severity: 'info', code: 'flagged_out_of_stock', message: 'Marked out of stock in Sakash but has a positive stock count; the count was used' });

  const promo = toNumber(raw.promoDiscountPercent) ?? 0;
  const attributes: Record<string, unknown> = {
    legacy: true,
    ...(str(raw.fabricType) && { fabricType: str(raw.fabricType) }),
    ...(str(raw.material) && { material: str(raw.material) }),
    ...(strList(raw.availableColors).length && { colors: strList(raw.availableColors) }),
    ...(strList(raw.availableSizes).length && { sizes: strList(raw.availableSizes) }),
    ...(toNumber(raw.yardage) && { yardage: toNumber(raw.yardage) }),
    ...(str(raw.gsm) && { gsm: str(raw.gsm) }),
    ...(str(raw.careInstructions) && { careInstructions: str(raw.careInstructions) }),
    ...(str(raw.occasion) && { occasion: str(raw.occasion) }),
    ...(str(raw.gender) && { gender: str(raw.gender) }),
    ...(str(raw.origin) && { origin: str(raw.origin) }),
    ...(strList(raw.categories).length && { categories: strList(raw.categories) }),
    ...(promo > 0 && { legacyPromoDiscountPercent: promo, legacyPromoText: str(raw.promoText) }),
    ...(str(raw.imageUrl ?? raw.image ?? raw.photoUrl) && { imageUrl: str(raw.imageUrl ?? raw.image ?? raw.photoUrl) }),
    ...(strList(raw.additionalImages).length && { additionalImages: strList(raw.additionalImages) }),
    ...(normalizeTimestamp(raw.createdAt) && { legacyCreatedAt: normalizeTimestamp(raw.createdAt) }),
  };

  const product: CanonicalProduct = {
    sourceId: id,
    name,
    description: str(raw.description),
    category: str(raw.category) || 'General',
    unitPrice: price.toFixed(4),
    stock,
    sku: skuFor(id),
    attributes,
    checksum: '',
  };
  product.checksum = checksumOf({ ...product, checksum: undefined });
  return { product, issues };
}
