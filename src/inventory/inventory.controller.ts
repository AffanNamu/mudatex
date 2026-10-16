import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { MudatexRequest } from '../auth/authenticated-request';
import { OidcAuthGuard } from '../auth/oidc-auth.guard';
import { OrganizationScopeGuard } from '../auth/organization-scope.guard';
import { InventoryWriteRoleGuard } from './inventory-write-role.guard';
import { ReceiveStockDto } from './dto/receive-stock.dto';
import { TransferStockDto } from './dto/transfer-stock.dto';
import { ListStockBalancesQueryDto } from './dto/list-stock-balances-query.dto';
import { InventoryService } from './inventory.service';
import { StockAdjustmentApprovalGuard } from './stock-adjustment-approval.guard';
import { RequestStockAdjustmentDto } from './dto/request-stock-adjustment.dto';
import { RejectStockAdjustmentDto } from './dto/reject-stock-adjustment.dto';

@Controller('inventory')
@UseGuards(OidcAuthGuard, OrganizationScopeGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('balances')
  listBalances(@Req() request: MudatexRequest, @Query() query: ListStockBalancesQueryDto) {
    return this.inventory.listBalances(request.organizationAccess!.organizationId, query);
  }

  @Get('adjustments')
  listAdjustments(@Req() request: MudatexRequest) {
    return this.inventory.listStockAdjustments(request.organizationAccess!.organizationId);
  }

  @Post('adjustments')
  @UseGuards(InventoryWriteRoleGuard)
  requestAdjustment(@Req() request: MudatexRequest, @Body() input: RequestStockAdjustmentDto) {
    return this.inventory.requestStockAdjustment(request.organizationAccess!.organizationId, request.principal!, input);
  }

  @Post('adjustments/:id/approve')
  @UseGuards(StockAdjustmentApprovalGuard)
  approveAdjustment(@Req() request: MudatexRequest, @Param('id') id: string) {
    return this.inventory.approveStockAdjustment(request.organizationAccess!.organizationId, request.principal!, id);
  }

  @Post('adjustments/:id/reject')
  @UseGuards(StockAdjustmentApprovalGuard)
  rejectAdjustment(@Req() request: MudatexRequest, @Param('id') id: string, @Body() input: RejectStockAdjustmentDto) {
    return this.inventory.rejectStockAdjustment(request.organizationAccess!.organizationId, request.principal!, id, input.reason);
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
