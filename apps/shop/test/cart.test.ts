import { describe, expect, it } from 'vitest';
import { addQty } from '../lib/cart';

describe('addQty', () => {
  it('adds decimal quantities without floating point noise', () => {
    expect(addQty('0.1', '0.2')).toBe('0.3');
    expect(addQty('2.5', '50')).toBe('52.5');
    expect(addQty('1.005', '1.005', 3)).toBe('2.01');
  });
});
