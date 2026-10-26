import { describe, expect, it } from 'vitest';
import { formatMoney, trimQty, whatsappLink } from '../lib/format';

describe('formatMoney', () => {
  it('formats minor units with the currency\'s decimals', () => {
    expect(formatMoney(376304, 'NGN', 2)).toContain('3,763.04');
    expect(formatMoney(1500, 'XOF', 0)).toContain('1,500');
    expect(formatMoney(5, 'USD', 2)).toContain('0.05');
  });
  it('falls back for an unknown currency code', () => {
    expect(formatMoney(100, 'XXXX', 2)).toBe('XXXX 1.00');
  });
});

describe('trimQty', () => {
  it('drops trailing zeros and a bare decimal point', () => {
    expect(trimQty('2.500000')).toBe('2.5');
    expect(trimQty('50.00')).toBe('50');
    expect(trimQty('100')).toBe('100');
    expect(trimQty('0.25')).toBe('0.25');
  });
});

describe('whatsappLink', () => {
  it('builds a wa.me link with the message encoded', () => {
    expect(whatsappLink('+234 801 234 5678', 'Hi there & hello')).toBe('https://wa.me/2348012345678?text=Hi%20there%20%26%20hello');
  });
  it('is null without a number', () => {
    expect(whatsappLink(undefined, 'x')).toBeNull();
  });
});
