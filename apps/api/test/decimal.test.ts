import { describe, expect, it } from 'vitest';
import { convertExact, fromScaled, normalize, sum, toScaled } from '../src/domain/decimal.js';
import { QuantityError } from '../src/domain/quantity.js';

describe('decimal', () => {
  it('round-trips and normalizes without floating point', () => {
    expect(fromScaled(toScaled('12.5'))).toBe('12.5');
    expect(normalize('12.500000')).toBe('12.5');
    expect(normalize('-2.500000')).toBe('-2.5');
    expect(normalize('0.000000')).toBe('0');
    expect(sum(['0.1', '0.2'])).toBe('0.3');
    expect(fromScaled(-1500000n)).toBe('-1.5');
  });

  it('rejects more than six decimal places', () => {
    expect(() => toScaled('1.1234567')).toThrow(QuantityError);
  });

  it('converts exactly or not at all', () => {
    expect(convertExact('3', '50', 2)).toBe('150');
    expect(convertExact('2500', '0.9144', 2)).toBe('2286');
    expect(convertExact('1.5', '0.5', 2)).toBe('0.75');
    expect(() => convertExact('1', '0.9144', 2)).toThrow(QuantityError);
    expect(() => convertExact('1', '0.333', 2)).toThrow(QuantityError);
  });
});
