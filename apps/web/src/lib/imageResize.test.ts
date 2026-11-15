import { describe, expect, it } from 'vitest';
import { fitWithin } from './imageResize';

describe('fitWithin', () => {
  it('shrinks the longest side to the limit and keeps the shape', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(3, 2000, 1000)).toEqual({ width: 2, height: 1000 });
  });
  it('never enlarges, and never returns an empty picture', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(0, 0)).toEqual({ width: 1, height: 1 });
    expect(fitWithin(1, 100000)).toEqual({ width: 1, height: 1600 });
  });
});
