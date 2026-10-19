import { describe, expect, it } from 'vitest';
import { linkTokenFromHash, refreshDelay } from './identity';

describe('refreshDelay', () => {
  it('refreshes a minute before a normal token expires', () => {
    expect(refreshDelay(10_000_000 + 3_600_000, 10_000_000)).toBe(3_540_000);
  });
  it('refreshes halfway through a very short life, and immediately once expired', () => {
    expect(refreshDelay(1_000 + 6_000, 1_000)).toBe(3_000);
    expect(refreshDelay(1_000, 5_000)).toBe(0);
  });
});

describe('linkTokenFromHash', () => {
  it('accepts only recovery and invitation links', () => {
    expect(linkTokenFromHash('#access_token=abc&type=recovery&expires_in=3600')).toBe('abc');
    expect(linkTokenFromHash('#access_token=abc&type=invite')).toBe('abc');
    expect(linkTokenFromHash('#access_token=abc&type=magiclink')).toBeNull();
    expect(linkTokenFromHash('#access_token=abc')).toBeNull();
    expect(linkTokenFromHash('#type=recovery')).toBeNull();
    expect(linkTokenFromHash('')).toBeNull();
  });
});
