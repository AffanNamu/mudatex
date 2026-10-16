import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { MudatexRequest } from '../auth/authenticated-request';
import { OidcAuthGuard } from '../auth/oidc-auth.guard';
import { OrganizationScopeGuard } from '../auth/organization-scope.guard';
import { InventoryWriteRoleGuard } from './inventory-write-role.guard';
import { CreateStockReservationDto } from './dto/create-stock-reservation.dto';
import { FulfillStockReservationDto } from './dto/fulfill-stock-reservation.dto';
import { ReleaseStockReservationDto } from './dto/release-stock-reservation.dto';
import { StockReservationService } from './stock-reservation.service';

@Controller('inventory/stock-reservations')
@UseGuards(OidcAuthGuard, OrganizationScopeGuard)
export class StockReservationsController {
  constructor(private readonly reservations: StockReservationService) {}

  @Get()
  list(@Req() request: MudatexRequest) {
    return this.reservations.list(request.organizationAccess!.organizationId);
  }

  @Post()
  @UseGuards(InventoryWriteRoleGuard)
  create(@Req() request: MudatexRequest, @Body() input: CreateStockReservationDto) {
    return this.reservations.create(request.organizationAccess!.organizationId, request.principal!, input);
  }

  @Post(':id/release')
  @UseGuards(InventoryWriteRoleGuard)
  release(@Req() request: MudatexRequest, @Param('id') id: string, @Body() input: ReleaseStockReservationDto) {
    return this.reservations.release(request.organizationAccess!.organizationId, request.principal!, id, input.reason);
  }

  @Post(':id/fulfill')
  @UseGuards(InventoryWriteRoleGuard)
  fulfill(@Req() request: MudatexRequest, @Param('id') id: string, @Body() input: FulfillStockReservationDto) {
    return this.reservations.fulfill(request.organizationAccess!.organizationId, request.principal!, id, input);
  }
}
