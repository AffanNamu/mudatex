# Authentication and organization authorization

## Status

This is a security foundation, not a complete login experience. Mudatex does not issue tokens. The API validates access tokens issued by a configured OpenID Connect identity provider using its JWKS endpoint.

## Required environment

Configure all three values before applying `OidcAuthGuard` to protected controllers:

- `AUTH_ISSUER`: exact issuer URL expected in the token's `iss` claim.
- `AUTH_AUDIENCE`: API audience expected in the token's `aud` claim.
- `AUTH_JWKS_URL`: HTTPS URL for the provider's JSON Web Key Set (localhost is permitted for local development only).

If configuration is missing or invalid, the guard fails closed. Tokens must be signed with RS256 or ES256 and must pass issuer, audience, signature, and expiry checks. The API must never trust identity or role values sent in custom headers.

## Organization scope

For protected organization endpoints, apply both `OidcAuthGuard` and `OrganizationScopeGuard`. The latter requires `X-Organization-Id` and resolves an active membership using the verified token's issuer and subject. The organization ID header selects a requested scope; it does not grant access by itself.

Membership role is returned in the request context. Controllers and services must still enforce action-specific permissions; never assume every active member may perform every action. Legal-entity, branch, warehouse, and record-level scopes must be checked by domain services before those scopes are introduced.

## Provisioning and operational controls

Membership provisioning is intentionally not exposed as a public API in this phase. It must be restricted to a verified bootstrap/admin process with audit logging. Do not create a default owner, seed production credentials, accept client-supplied roles, or add an unauthenticated bypass.

The health endpoints remain public and should not use these guards. Protected controllers must explicitly apply both guards until a reviewed global-guard/public-route policy is implemented.
