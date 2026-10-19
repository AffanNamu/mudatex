import { describe, expect, it } from 'vitest';
import { requiredQuantity, withinTolerance } from '../src/domain/manufacturing.js';

describe('requiredQuantity', () => {
  it('scales by planned output, scrap and yield, rounding up', () => {
    expect(requiredQuantity('2', '100', '1', 0, 10000)).toBe('200');
    expect(requiredQuantity('2', '100', '1', 500, 10000)).toBe('210');          // +5% scrap
    expect(requiredQuantity('2', '100', '1', 0, 8000)).toBe('250');             // 80% yield needs 25% more
    expect(requiredQuantity('1.5', '10', '4', 0, 10000)).toBe('3.75');          // BOM quoted per 4 units
    expect(requiredQuantity('1', '1', '3', 0, 10000)).toBe('0.333334');         // 0.333333.. rounds up, never down
    expect(requiredQuantity('0.000001', '1', '1', 0, 10000)).toBe('0.000001');
  });
});

describe('withinTolerance', () => {
  it('is inclusive and symmetric', () => {
    const s = (n: number) => BigInt(n) * 1_000_000n;
    expect(withinTolerance(s(105), s(100), 500)).toBe(true);
    expect(withinTolerance(s(95), s(100), 500)).toBe(true);
    expect(withinTolerance(s(106), s(100), 500)).toBe(false);
    expect(withinTolerance(s(94), s(100), 500)).toBe(false);
    expect(withinTolerance(s(100), s(100), 0)).toBe(true);
    expect(withinTolerance(1n, s(100), 0)).toBe(false);
  });
});
