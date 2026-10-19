import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney, parseQuantity } from './money';

describe('formatMoney', () => {
  it('groups thousands and pads minor units, for any number of decimals', () => {
    expect(formatMoney(2822278, 'NGN', 2)).toBe('₦28,222.78');
    expect(formatMoney(5, 'NGN', 2)).toBe('₦0.05');
    expect(formatMoney(0, 'USD', 2)).toBe('$0.00');
    expect(formatMoney(1234567, 'XOF', 0)).toBe('CFA 1,234,567');
    expect(formatMoney(-150, 'NGN', 2)).toBe('-₦1.50');
    expect(formatMoney(100000000, 'XXX', 3)).toBe('XXX 100,000.000');
  });
});

describe('parseMoney', () => {
  it('reads typed amounts exactly and refuses anything it would have to round', () => {
    expect(parseMoney('1,234.5', 2)).toBe(123450);
    expect(parseMoney('0.05', 2)).toBe(5);
    expect(parseMoney('  20 ', 2)).toBe(2000);
    expect(parseMoney('1500', 0)).toBe(1500);
    expect(parseMoney('10.005', 2)).toBeNull();
    expect(parseMoney('1.5', 0)).toBeNull();
    for (const bad of ['', 'abc', '-5', '1e3', '1.', '.5', '1 000', '9'.repeat(20)]) expect(parseMoney(bad, 2)).toBeNull();
  });
});

describe('parseQuantity', () => {
  it('accepts positive decimals only, unchanged', () => {
    expect(parseQuantity('2.50')).toBe('2.50');
    expect(parseQuantity(' 7 ')).toBe('7');
    for (const bad of ['0', '0.0', '-1', 'x', '', '1.', '.5']) expect(parseQuantity(bad)).toBeNull();
  });
});
