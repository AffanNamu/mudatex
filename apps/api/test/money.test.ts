import { describe, expect, it } from 'vitest';
import { grossMinor, MoneyError, priceLine, refundShare, roundDiv } from '../src/domain/money.js';

describe('money', () => {
  it('rounds half up and never uses floats', () => {
    expect(roundDiv(5n, 10n)).toBe(1n);
    expect(roundDiv(4n, 10n)).toBe(0n);
    expect(roundDiv(15n, 10n)).toBe(2n);
    // 0.1 x 3 style traps
    expect(grossMinor('3', '0.1000', 2)).toBe(30n);
    expect(grossMinor('7.5', '3500.5000', 2)).toBe(2625375n); // 26,253.75
    expect(grossMinor('0.333333', '3.0000', 2)).toBe(100n);
    expect(grossMinor('1', '1.0050', 2)).toBe(101n); // half-up
    expect(grossMinor('2', '1000', 0)).toBe(2000n); // zero-decimal currency
  });

  it('applies percent and amount discounts', () => {
    const base = { quantity: '2', unitPrice: '100.0000', minorUnit: 2 };
    expect(priceLine({ ...base, discount: { type: 'percent', basisPoints: 1000 } })).toMatchObject({ gross: 20000n, discount: 2000n, total: 18000n });
    expect(priceLine({ ...base, discount: { type: 'amount', amountMinor: 500 } })).toMatchObject({ discount: 500n, total: 19500n });
    expect(() => priceLine({ ...base, discount: { type: 'amount', amountMinor: 20001 } })).toThrow(MoneyError);
  });

  it('adds exclusive tax and extracts inclusive tax', () => {
    const base = { quantity: '1', unitPrice: '100.0000', minorUnit: 2 };
    const excl = priceLine({ ...base, tax: { code: 'VAT', rate: '0.075', inclusive: false } });
    expect(excl).toMatchObject({ net: 10000n, tax: 750n, total: 10750n });
    const incl = priceLine({ ...base, tax: { code: 'VAT', rate: '0.075', inclusive: true } });
    expect(incl).toMatchObject({ net: 10000n, tax: 698n, total: 10000n }); // 100 - 100/1.075 = 6.9767
    // tax is computed after the discount
    const disc = priceLine({ ...base, discount: { type: 'percent', basisPoints: 1000 }, tax: { code: 'VAT', rate: '0.075', inclusive: false } });
    expect(disc).toMatchObject({ net: 9000n, tax: 675n, total: 9675n });
  });

  it('splits refunds so partial returns add up exactly to the line total', () => {
    const total = 10001n; // not divisible by 3
    const a = refundShare(total, '3', '0', '1');
    const b = refundShare(total, '3', '1', '2');
    const c = refundShare(total, '3', '2', '3');
    expect(a + b + c).toBe(total);
    expect(refundShare(total, '3', '0', '3')).toBe(total);
    expect(refundShare(total, '3', '1', '1')).toBe(0n);
  });
});
