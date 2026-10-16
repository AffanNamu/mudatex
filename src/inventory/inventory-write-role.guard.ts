import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { MudatexRequest } from '../auth/authenticated-request';

@Injectable()
export class InventoryWriteRoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<MudatexRequest>();
    if (!request.organizationAccess) {
      throw new UnauthorizedException('Organization scope must be established before checking permissions');
    }

    if (!['OWNER', 'ADMIN', 'MANAGER', 'STAFF'].includes(request.organizationAccess.role)) {
      throw new ForbiddenException('Your organization role cannot receive inventory');
    }
    return true;
  }
}
