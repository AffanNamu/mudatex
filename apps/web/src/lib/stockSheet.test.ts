import { describe, expect, it } from 'vitest';
import { findByCode, plusOne, quantityFor, searchItems, type Sheet, type SheetItem } from './stockSheet';

const item = (over: Partial<SheetItem>): SheetItem => ({ variantId: 'v', sku: 'SKU', productName: 'Thing', tracking: 'none', unit: 'pc', unitKind: 'discrete', precision: 0, barcodes: [], balances: [], ...over });
const sheet: Sheet = {
  locationId: 'l', generatedAt: '2026-01-01T00:00:00Z', truncated: false,
  items: [
    item({ variantId: 'a', sku: 'BRO-GLD', productName: 'Brocade Gold', unit: 'm', unitKind: 'decimal', precision: 2, barcodes: ['6001'] }),
    item({ variantId: 'b', sku: 'LACE-W', productName: 'Swiss Lace White', barcodes: ['6002', '6003'] }),
  ],
};

describe('stock sheet helpers', () => {
  it('finds by exact barcode or SKU, ignoring case on SKUs', () => {
    expect(findByCode(sheet, '6003').map((i) => i.variantId)).toEqual(['b']);
    expect(findByCode(sheet, ' bro-gld ').map((i) => i.variantId)).toEqual(['a']);
    expect(findByCode(sheet, '600')).toEqual([]);
    expect(findByCode(undefined, '6001')).toEqual([]);
  });
  it('searches by every word, needs two characters', () => {
    expect(searchItems(sheet, 'swiss white').map((i) => i.variantId)).toEqual(['b']);
    expect(searchItems(sheet, 'gold')).toHaveLength(1);
    expect(searchItems(sheet, 'g')).toEqual([]);
  });
  it('accepts quantities only as the unit allows, and never rounds', () => {
    const m = sheet.items[0]!;
    const pc = sheet.items[1]!;
    expect(quantityFor('12.5', m)).toBe('12.5');
    expect(quantityFor('12.555', m)).toBeNull();
    expect(quantityFor('3', pc)).toBe('3');
    expect(quantityFor('3.5', pc)).toBeNull();
    expect(quantityFor('0', pc)).toBeNull();
    expect(quantityFor('0', pc, true)).toBe('0');
    expect(quantityFor('-1', pc, true)).toBeNull();
    expect(quantityFor('', pc, true)).toBeNull();
  });
  it('counts up by one', () => {
    expect(plusOne('')).toBe('1');
    expect(plusOne('9')).toBe('10');
  });
});
