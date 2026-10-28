import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enrollTotp, linkTokenFromHash, listFactors, refreshDelay, SignInError, tokenAal, verifyTotp } from './identity';

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

const jwt = (claims: object) => `h.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;

describe('tokenAal', () => {
  it('reads the assurance level the sign-in service put in the token, for the screen only', () => {
    expect(tokenAal(jwt({ aal: 'aal2' }))).toBe('aal2');
    expect(tokenAal(jwt({ aal: 'aal1' }))).toBe('aal1');
    expect(tokenAal(jwt({}))).toBeNull();
    expect(tokenAal('garbage')).toBeNull();
  });
});

describe('second factor calls', () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let calls: { url: string; method?: string; body?: unknown; auth?: string }[];
  const respond = vi.fn<(url: string) => Response>();
  beforeEach(() => {
    calls = [];
    window.__MUDATEX__ = { supabaseUrl: 'https://p.supabase.co', supabaseKey: 'anon' };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as Record<string, string>)?.authorization });
      return respond(url);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); delete window.__MUDATEX__; respond.mockReset(); });

  it('lists only authenticator apps and tells verified from half-finished ones', async () => {
    respond.mockReturnValue(reply(200, { factors: [{ id: 'a', factor_type: 'totp', status: 'verified', friendly_name: 'Phone' }, { id: 'b', factor_type: 'totp', status: 'unverified' }, { id: 'c', factor_type: 'phone', status: 'verified' }] }));
    expect(await listFactors('tok')).toEqual([{ id: 'a', status: 'verified', friendlyName: 'Phone' }, { id: 'b', status: 'unverified', friendlyName: null }]);
    expect(calls[0]).toMatchObject({ url: 'https://p.supabase.co/auth/v1/user', auth: 'Bearer tok' });
  });

  it('enrols an authenticator app and returns the picture and the key', async () => {
    respond.mockReturnValue(reply(200, { id: 'f1', totp: { qr_code: 'data:image/svg+xml;utf8,<svg/>', secret: 'ABCD' } }));
    expect(await enrollTotp('tok')).toEqual({ factorId: 'f1', qrCode: 'data:image/svg+xml;utf8,<svg/>', secret: 'ABCD' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://p.supabase.co/auth/v1/factors', body: { factor_type: 'totp', issuer: 'Mudatex' } });
  });

  it('challenges, then verifies the code with spaces removed, and returns the stronger session', async () => {
    respond.mockImplementation((url) => url.endsWith('/challenge') ? reply(200, { id: 'ch1' }) : reply(200, { access_token: 'new', refresh_token: 'r', expires_in: 3600 }));
    const t = await verifyTotp('tok', 'f1', '123 456');
    expect(t).toMatchObject({ accessToken: 'new', refreshToken: 'r' });
    expect(calls.map((c) => c.url)).toEqual(['https://p.supabase.co/auth/v1/factors/f1/challenge', 'https://p.supabase.co/auth/v1/factors/f1/verify']);
    expect(calls[1]!.body).toEqual({ challenge_id: 'ch1', code: '123456' });
  });

  it('explains a wrong code and a rate limit in plain words', async () => {
    respond.mockImplementation((url) => url.endsWith('/challenge') ? reply(200, { id: 'ch1' }) : reply(400, { error_code: 'mfa_verification_failed' }));
    await expect(verifyTotp('tok', 'f1', '000000')).rejects.toMatchObject({ kind: 'credentials', message: expect.stringContaining('not right') });
    respond.mockImplementation(() => reply(429, {}));
    await expect(verifyTotp('tok', 'f1', '000000')).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(SignInError).toBeDefined();
  });
});
