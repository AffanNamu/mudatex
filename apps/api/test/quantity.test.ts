import { describe, expect, it } from 'vitest';
import { parseQuantity, QuantityError } from '../src/domain/quantity.js';

const metre = { code: 'm', kind: 'decimal', precision: 2 } as const;
const roll = { code: 'roll', kind: 'discrete', precision: 0 } as const;

describe('parseQuantity', () => {
  it('accepts values within the unit precision', () => {
    expect(parseQuantity('7.5', metre)).toBe('7.5');
    expect(parseQuantity('12', metre)).toBe('12');
    expect(parseQuantity('3', roll)).toBe('3');
  });

  it('rejects over-precise quantities instead of rounding', () => {
    expect(() => parseQuantity('1.234', metre)).toThrow(QuantityError);
  });

  it('rejects fractions of a discrete unit', () => {
    expect(() => parseQuantity('2.5', roll)).toThrow(QuantityError);
  });

  it('rejects negative, exponent and malformed input', () => {
    for (const bad of ['-1', '1e3', '', '1.', '.5', 'abc', ' 1']) {
      expect(() => parseQuantity(bad, metre)).toThrow(QuantityError);
    }
  });
});
