import { describe, expect, it } from 'vitest';
import { priceLine } from '../../../api/src/domain/money';
import { priceLineLocal, sumLines } from './offlinePricing';

describe('offline pricing follows the server\'s rules', () => {
  it('gives the known server results', () => {
    // 2 m x 3,500.50, 7.5% tax added: the figure the server's own tests expect
    expect(priceLineLocal({ quantity: '2', unitPrice: '3500.50', minorUnit: 2, discountBps: 0, taxRate: '0.075', taxInclusive: false })).toMatchObject({ gross: 700100, total: 752608, tax: 52508 });
    // 33.34 with 7.5% already inside the price
    expect(priceLineLocal({ quantity: '1', unitPrice: '33.34', minorUnit: 2, discountBps: 0, taxRate: '0.075', taxInclusive: true })).toMatchObject({ gross: 3334, total: 3334, tax: 233 });
  });

  it('matches the server on many random lines, to the minor unit', () => {
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 2000; i++) {
      const quantity = `${rnd(500)}.${String(rnd(100)).padStart(2, '0')}`;
      if (Number(quantity) === 0) continue;
      const unitPrice = `${rnd(100000)}.${String(rnd(10000)).padStart(4, '0')}`;
      const minorUnit = [0, 2, 3][rnd(3)]!;
      const discountBps = rnd(3) === 0 ? 0 : rnd(5000) + 1;
      const rate = rnd(3) === 0 ? null : `0.${String(rnd(300000)).padStart(6, '0')}`;
      const inclusive = rnd(2) === 0;
      const server = priceLine({ quantity, unitPrice, minorUnit, discount: discountBps ? { type: 'percent', basisPoints: discountBps } : undefined, tax: rate ? { code: 'T', rate, inclusive } : null });
      const local = priceLineLocal({ quantity, unitPrice, minorUnit, discountBps, taxRate: rate, taxInclusive: inclusive });
      expect(local, JSON.stringify({ quantity, unitPrice, minorUnit, discountBps, rate, inclusive })).toEqual({ gross: Number(server.gross), discount: Number(server.discount), tax: Number(server.tax), total: Number(server.total) });
    }
  });

  it('sums lines so a receipt adds up', () => {
    const a = priceLineLocal({ quantity: '1.5', unitPrice: '100', minorUnit: 2, discountBps: 0, taxRate: null, taxInclusive: false });
    const b = priceLineLocal({ quantity: '2', unitPrice: '33.33', minorUnit: 2, discountBps: 1000, taxRate: '0.075', taxInclusive: false });
    expect(sumLines([a, b]).total).toBe(a.total + b.total);
  });
});
