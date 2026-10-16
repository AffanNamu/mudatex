import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { DatabaseService } from '../database/prisma.service';
import type { MudatexRequest } from './authenticated-request';

@Injectable()
export class OrganizationScopeGuard implements CanActivate {
  constructor(private readonly database: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MudatexRequest>();
    const principal = request.principal;
    if (!principal) throw new UnauthorizedException('Authenticated principal is required');

    const organizationId = request.headers['x-organization-id'];
    if (typeof organizationId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)) {
      throw new ForbiddenException('A valid X-Organization-Id scope is required');
    }

    const membership = await this.database.organizationMembership.findFirst({
      where: {
        organizationId,
        issuer: principal.issuer,
        subject: principal.subject,
        status: 'ACTIVE',
        organization: { active: true },
      },
      select: { organizationId: true, role: true },
    });

    if (!membership) {
      throw new ForbiddenException('No active membership exists for this organization');
    }

    request.organizationAccess = membership;
    return true;
  }
}
