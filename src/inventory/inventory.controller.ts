import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { MudatexRequest } from '../auth/authenticated-request';
import { OidcAuthGuard } from '../auth/oidc-auth.guard';
import { OrganizationScopeGuard } from '../auth/organization-scope.guard';
import { InventoryWriteRoleGuard } from './inventory-write-role.guard';
import { ReceiveStockDto } from './dto/receive-stock.dto';
import { TransferStockDto } from './dto/transfer-stock.dto';
import { ListStockBalancesQueryDto } from './dto/list-stock-balances-query.dto';
import { InventoryService } from './inventory.service';

@Controller('inventory')
@UseGuards(OidcAuthGuard, OrganizationScopeGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('balances')
  listBalances(@Req() request: MudatexRequest, @Query() query: ListStockBalancesQueryDto) {
    return this.inventory.listBalances(request.organizationAccess!.organizationId, query);
  }

  @Post('receipts')
  @UseGuards(InventoryWriteRoleGuard)
  receive(@Req() request: MudatexRequest, @Body() input: ReceiveStockDto) {
    return this.inventory.receive(request.organizationAccess!.organizationId, request.principal!, input);
  }

  @Post('transfers')
  @UseGuards(InventoryWriteRoleGuard)
  transfer(@Req() request: MudatexRequest, @Body() input: TransferStockDto) {
    return this.inventory.transfer(request.organizationAccess!.organizationId, request.principal!, input);
  }
}
