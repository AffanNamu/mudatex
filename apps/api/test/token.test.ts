import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTokenVerifier } from '../src/auth/token.js';
import { loadConfig } from '../src/config.js';

// What a Supabase (or Firebase) project looks like to the API: a public key set, an issuer and an audience.
const ISSUER = 'https://project-ref.supabase.co/auth/v1';
let server: Server;
let verify: ReturnType<typeof createTokenVerifier>;
let es: Awaited<ReturnType<typeof generateKeyPair>>;
let stranger: Awaited<ReturnType<typeof generateKeyPair>>;

const sign = (key: Parameters<SignJWT['sign']>[0], alg: string, claims: Record<string, unknown> = {}, o: { iss?: string; aud?: string; exp?: string | number; kid?: string } = {}) => {
  const jwt = new SignJWT({ ...claims }).setProtectedHeader({ alg, kid: o.kid ?? 'k1' }).setSubject('11111111-2222-3333-4444-555555555555')
    .setIssuedAt().setIssuer(o.iss ?? ISSUER).setAudience(o.aud ?? 'authenticated');
  return (o.exp === undefined ? jwt.setExpirationTime('1h') : jwt.setExpirationTime(o.exp)).sign(key);
};

beforeAll(async () => {
  es = await generateKeyPair('ES256');
  stranger = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(es.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  server = createServer((_, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`;
  verify = createTokenVerifier(loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'x', AUTH_JWKS_URL: url, AUTH_ISSUER: ISSUER, AUTH_AUDIENCE: 'authenticated' }));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('tokens from an identity provider', () => {
  it('accepts a correctly signed, unexpired token and returns the subject', async () => {
    expect(await verify(await sign(es.privateKey, 'ES256'))).toEqual({ subject: '11111111-2222-3333-4444-555555555555' });
  });

  it('rejects tokens from another issuer or for another audience', async () => {
    await expect(verify(await sign(es.privateKey, 'ES256', {}, { iss: 'https://other.supabase.co/auth/v1' }))).rejects.toMatchObject({ status: 401 });
    await expect(verify(await sign(es.privateKey, 'ES256', {}, { aud: 'anon' }))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects expired tokens, tokens signed by a different key, and tokens naming an unknown key', async () => {
    await expect(verify(await sign(es.privateKey, 'ES256', {}, { exp: Math.floor(Date.now() / 1000) - 60 }))).rejects.toMatchObject({ status: 401 });
    await expect(verify(await sign(stranger.privateKey, 'ES256'))).rejects.toMatchObject({ status: 401 });
    await expect(verify(await sign(es.privateKey, 'ES256', {}, { kid: 'unknown' }))).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a shared-secret (HS256) token even if it is signed with the public key material, and unsigned tokens', async () => {
    const jwkText = new TextEncoder().encode(JSON.stringify(await exportJWK(es.publicKey)));
    await expect(verify(await sign(jwkText, 'HS256'))).rejects.toMatchObject({ status: 401 });
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'x', iss: ISSUER, aud: 'authenticated', exp: 9999999999 })).toString('base64url')}.`;
    await expect(verify(none)).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a token with no expiry', async () => {
    const t = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setSubject('x').setIssuer(ISSUER).setAudience('authenticated').sign(es.privateKey);
    await expect(verify(t)).rejects.toMatchObject({ status: 401 });
  });
});
