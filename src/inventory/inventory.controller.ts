import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { MudatexRequest } from '../auth/authenticated-request';
import { OidcAuthGuard } from '../auth/oidc-auth.guard';
import { OrganizationScopeGuard } from '../auth/organization-scope.guard';
import { InventoryWriteRoleGuard } from './inventory-write-role.guard';
import { ReceiveStockDto } from './dto/receive-stock.dto';
import { InventoryService } from './inventory.service';

@Controller('inventory')
@UseGuards(OidcAuthGuard, OrganizationScopeGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Post('receipts')
  @UseGuards(InventoryWriteRoleGuard)
  receive(@Req() request: MudatexRequest, @Body() input: ReceiveStockDto) {
    return this.inventory.receive(
      request.organizationAccess!.organizationId,
      request.principal!,
      input,
    );
  }
}
