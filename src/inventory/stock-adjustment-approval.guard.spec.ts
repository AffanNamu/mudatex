import { ForbiddenException } from '@nestjs/common';
import { StockAdjustmentApprovalGuard } from './stock-adjustment-approval.guard';

describe('StockAdjustmentApprovalGuard', () => {
  const guard = new StockAdjustmentApprovalGuard();
  const contextFor = (role?: string) => ({
    switchToHttp: () => ({
      getRequest: () => ({ organizationAccess: role ? { organizationId: 'org-1', role } : undefined }),
    }),
  }) as never;

  it('allows an organization manager to review adjustments', () => {
    expect(guard.canActivate(contextFor('MANAGER'))).toBe(true);
    expect(guard.canActivate(contextFor('OWNER'))).toBe(true);
  });

  it('does not allow staff or viewers to review adjustments', () => {
    expect(() => guard.canActivate(contextFor('STAFF'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor('VIEWER'))).toThrow(ForbiddenException);
  });
});
