import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MudatexRequest } from './authenticated-request';

@Injectable()
export class OidcAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const issuer = process.env.AUTH_ISSUER;
    const audience = process.env.AUTH_AUDIENCE;
    const jwksUrl = process.env.AUTH_JWKS_URL;

    // Authentication is intentionally fail-closed until an identity provider is configured.
    if (!issuer || !audience || !jwksUrl) {
      throw new ServiceUnavailableException('Authentication provider is not configured');
    }

    let jwks: ReturnType<typeof createRemoteJWKSet>;
    try {
      const parsed = new URL(jwksUrl);
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
        throw new Error('JWKS endpoint must use HTTPS');
      }
      jwks = createRemoteJWKSet(parsed);
    } catch {
      throw new ServiceUnavailableException('Authentication provider configuration is invalid');
    }

    const request = context.switchToHttp().getRequest<MudatexRequest>();
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) {
      throw new UnauthorizedException('Bearer access token is required');
    }

    try {
      const { payload } = await jwtVerify(match[1], jwks, {
        issuer,
        audience,
        algorithms: ['RS256', 'ES256'],
      });
      if (typeof payload.iss !== 'string' || typeof payload.sub !== 'string' || !payload.sub) {
        throw new UnauthorizedException('Token is missing required identity claims');
      }
      request.principal = {
        issuer: payload.iss,
        subject: payload.sub,
        claims: payload as Record<string, unknown>,
      };
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Access token is invalid or expired');
    }
  }
}
