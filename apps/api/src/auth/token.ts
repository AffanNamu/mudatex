import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Config } from '../config.js';
import { unauthorized } from '../errors.js';

export type TokenVerifier = (token: string) => Promise<{ subject: string }>;

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
      });
      if (!payload.sub) throw new Error('missing sub');
      return { subject: payload.sub };
    } catch {
      throw unauthorized('Invalid or expired token');
    }
  };
}
