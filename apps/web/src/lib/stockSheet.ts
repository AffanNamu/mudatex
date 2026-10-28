/** The phone's copy of one place's stock list, and the small pure helpers that work on it. */

export interface SheetBalance { lotId: string | null; lotCode: string | null; quarantined: boolean; quantity: string; reserved: string; available: string }
export interface SheetItem {
  variantId: string; sku: string; productName: string; tracking: 'none' | 'lot' | 'roll';
  unit: string; unitKind: 'discrete' | 'decimal'; precision: number; barcodes: string[]; balances: SheetBalance[];
}
export interface Sheet { locationId: string; generatedAt: string; truncated: boolean; items: SheetItem[] }

/** Exact match on a scanned barcode or SKU (case does not matter for SKUs). */
export function findByCode(sheet: Sheet | undefined, code: string): SheetItem[] {
  const c = code.trim();
  if (!sheet || !c) return [];
  const lower = c.toLowerCase();
  return sheet.items.filter((i) => i.barcodes.includes(c) || i.sku.toLowerCase() === lower);
}

/** Typed search: every word must appear in the name or SKU. */
export function searchItems(sheet: Sheet | undefined, text: string, limit = 20): SheetItem[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!sheet || !words.length || text.trim().length < 2) return [];
  const out: SheetItem[] = [];
  for (const i of sheet.items) {
    const hay = `${i.productName} ${i.sku}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) { out.push(i); if (out.length >= limit) break; }
  }
  return out;
}

/** A typed quantity valid for the item's unit (zero allowed when `allowZero`), else null. Never rounds. */
export function quantityFor(text: string, item: Pick<SheetItem, 'unitKind' | 'precision'>, allowZero = false): string | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [, frac = ''] = t.split('.');
  if (frac.length > item.precision || (item.unitKind === 'discrete' && frac.length > 0)) return null;
  if (!allowZero && Number(t) === 0) return null;
  return t;
}

/** One more of a discrete item, as a string (decimal strings are only ever added as whole numbers here). */
export function plusOne(text: string): string {
  const n = /^\d+$/.test(text.trim()) ? Number(text) : 0;
  return String(n + 1);
}

export const ageMinutes = (iso: string, now = Date.now()) => Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
