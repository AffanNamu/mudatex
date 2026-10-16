import type { Request } from 'express';

export interface AuthenticatedPrincipal {
  issuer: string;
  subject: string;
  claims: Record<string, unknown>;
}

export interface OrganizationAccess {
  organizationId: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'STAFF' | 'VIEWER';
}

export type MudatexRequest = Request & {
  principal?: AuthenticatedPrincipal;
  organizationAccess?: OrganizationAccess;
};
