import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { ProductWriteRoleGuard } from './product-write-role.guard';

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('ProductWriteRoleGuard', () => {
  const guard = new ProductWriteRoleGuard();

  it.each(['OWNER', 'ADMIN', 'MANAGER'])('allows %s to create products', (role) => {
    expect(guard.canActivate(contextFor({ organizationAccess: { organizationId: 'org', role } }))).toBe(true);
  });

  it.each(['STAFF', 'VIEWER'])('rejects %s from product creation', (role) => {
    expect(() => guard.canActivate(contextFor({ organizationAccess: { organizationId: 'org', role } })))
      .toThrow(ForbiddenException);
  });

  it('rejects requests without an established organization scope', () => {
    expect(() => guard.canActivate(contextFor({}))).toThrow(UnauthorizedException);
  });
});
