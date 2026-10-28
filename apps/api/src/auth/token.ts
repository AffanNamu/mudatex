import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Config } from '../config.js';
import { unauthorized } from '../errors.js';

export type TokenVerifier = (token: string) => Promise<{ subject: string; email?: string; aal?: 'aal1' | 'aal2' }>;

export function createTokenVerifier(config: Config): TokenVerifier {
  let key: JWTVerifyGetKey | Uint8Array;
  if (config.AUTH_JWKS_URL) {
    key = createRemoteJWKSet(new URL(config.AUTH_JWKS_URL));
  } else if (config.AUTH_DEV_SECRET && config.NODE_ENV !== 'production') {
    key = new TextEncoder().encode(config.AUTH_DEV_SECRET);
  } else {
    throw new Error('No token verification key configured');
  }
  const algorithms = config.AUTH_JWKS_URL ? ['RS256', 'ES256'] : ['HS256'];

  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, key as never, {
        algorithms,
        issuer: config.AUTH_ISSUER,
        audience: config.AUTH_AUDIENCE,
        // Tokens must expire and name a subject; a token that never expires is rejected.
        requiredClaims: ['exp', 'sub'],
        clockTolerance: 5,
      });
      if (!payload.sub) throw new Error('missing sub');
      const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : undefined;
      // Supabase says how the person signed in: aal2 means a second factor (authenticator app) was verified in this session.
      const aal = payload.aal === 'aal1' || payload.aal === 'aal2' ? payload.aal : undefined;
      return { subject: payload.sub, ...(email ? { email } : {}), ...(aal ? { aal } : {}) };
    } catch {
      throw unauthorized('Invalid or expired token');
    }
  };
}
