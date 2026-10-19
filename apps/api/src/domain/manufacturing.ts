import { toScaled } from './decimal.js';
import { fromScaled } from './decimal.js';

/**
 * Component quantity needed to make `plannedQuantity` of good output from a BOM line quoted per
 * `bomOutputQuantity`, allowing for line scrap and the BOM's expected yield. Rounded UP at 6 decimals so a
 * work order never reserves less than it needs.
 *   required = line x planned x (1 + scrap) / (bomOutput x yield)
 */
export function requiredQuantity(lineQuantity: string, plannedQuantity: string, bomOutputQuantity: string, scrapBps: number, yieldBps: number): string {
  const num = toScaled(lineQuantity) * toScaled(plannedQuantity) * BigInt(10000 + scrapBps);   // scale 12
  const den = toScaled(bomOutputQuantity) * BigInt(yieldBps);                                  // scale 6
  return fromScaled((num + den - 1n) / den);                                                   // scale 6
}

/** True when actual is within `toleranceBps` of expected (inclusive), both in scale-6 fixed point. */
export function withinTolerance(actual: bigint, expected: bigint, toleranceBps: number): boolean {
  const diff = actual > expected ? actual - expected : expected - actual;
  return diff * 10000n <= expected * BigInt(toleranceBps);
}
