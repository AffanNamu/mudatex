import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { MudatexRequest } from '../auth/authenticated-request';
import { OidcAuthGuard } from '../auth/oidc-auth.guard';
import { OrganizationScopeGuard } from '../auth/organization-scope.guard';
import { InventoryWriteRoleGuard } from './inventory-write-role.guard';
import { StockAdjustmentApprovalGuard } from './stock-adjustment-approval.guard';
import { WarehouseTransferService } from './warehouse-transfer.service';
import { CreateWarehouseTransferDto } from './dto/create-warehouse-transfer.dto';
import { ReceiveWarehouseTransferDto } from './dto/receive-warehouse-transfer.dto';
import { RejectWarehouseTransferDto } from './dto/reject-warehouse-transfer.dto';

@Controller('inventory/warehouse-transfers')
@UseGuards(OidcAuthGuard, OrganizationScopeGuard)
export class WarehouseTransfersController {
  constructor(private readonly transfers: WarehouseTransferService) {}

  @Get()
  list(@Req() request: MudatexRequest) {
    return this.transfers.list(request.organizationAccess!.organizationId);
  }

  @Post()
  @UseGuards(InventoryWriteRoleGuard)
  create(@Req() request: MudatexRequest, @Body() input: CreateWarehouseTransferDto) {
    return this.transfers.createDraft(request.organizationAccess!.organizationId, request.principal!, input);
  }

  @Post(':id/submit')
  @UseGuards(InventoryWriteRoleGuard)
  submit(@Req() request: MudatexRequest, @Param('id') id: string) {
    return this.transfers.submit(request.organizationAccess!.organizationId, request.principal!, id);
  }

  @Post(':id/approve')
  @UseGuards(StockAdjustmentApprovalGuard)
  approve(@Req() request: MudatexRequest, @Param('id') id: string) {
    return this.transfers.approve(request.organizationAccess!.organizationId, request.principal!, id);
  }

  @Post(':id/reject')
  @UseGuards(StockAdjustmentApprovalGuard)
  reject(@Req() request: MudatexRequest, @Param('id') id: string, @Body() input: RejectWarehouseTransferDto) {
    return this.transfers.reject(request.organizationAccess!.organizationId, request.principal!, id, input.reason);
  }

  @Post(':id/dispatch')
  @UseGuards(InventoryWriteRoleGuard)
  dispatch(@Req() request: MudatexRequest, @Param('id') id: string) {
    return this.transfers.dispatch(request.organizationAccess!.organizationId, request.principal!, id);
  }

  @Post(':id/receive')
  @UseGuards(InventoryWriteRoleGuard)
  receive(@Req() request: MudatexRequest, @Param('id') id: string, @Body() input: ReceiveWarehouseTransferDto) {
    return this.transfers.receive(request.organizationAccess!.organizationId, request.principal!, id, input);
  }
}
