import { describe, expect, it } from 'vitest';
import { percentToBps } from './Pos';

describe('percentToBps', () => {
  it('converts typed percentages exactly', () => {
    expect(percentToBps('')).toBe(0);
    expect(percentToBps('10')).toBe(1000);
    expect(percentToBps('12.5')).toBe(1250);
    expect(percentToBps('0.01')).toBe(1);
    expect(percentToBps('100')).toBe(10000);
  });
  it('rejects anything ambiguous', () => {
    for (const bad of ['-1', '100.01', '1.234', 'abc', '1,5', '1e2', ' . ']) expect(percentToBps(bad), bad).toBeNull();
  });
});
