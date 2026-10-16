import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { InventoryWriteRoleGuard } from './inventory-write-role.guard';

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('InventoryWriteRoleGuard', () => {
  const guard = new InventoryWriteRoleGuard();

  it.each(['OWNER', 'ADMIN', 'MANAGER', 'STAFF'])('allows %s to receive inventory', (role) => {
    expect(guard.canActivate(contextFor({ organizationAccess: { organizationId: 'org', role } }))).toBe(true);
  });

  it('rejects VIEWER', () => {
    expect(() => guard.canActivate(contextFor({ organizationAccess: { organizationId: 'org', role: 'VIEWER' } })))
      .toThrow(ForbiddenException);
  });

  it('rejects requests without organization scope', () => {
    expect(() => guard.canActivate(contextFor({}))).toThrow(UnauthorizedException);
  });
});
