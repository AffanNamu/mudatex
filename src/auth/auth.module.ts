import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { OidcAuthGuard } from './oidc-auth.guard';
import { OrganizationScopeGuard } from './organization-scope.guard';

@Module({
  imports: [DatabaseModule],
  providers: [OidcAuthGuard, OrganizationScopeGuard],
  exports: [OidcAuthGuard, OrganizationScopeGuard],
})
export class AuthModule {}
