import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { InventoryController } from './inventory.controller';
import { InventoryWriteRoleGuard } from './inventory-write-role.guard';
import { InventoryService } from './inventory.service';
import { StockAdjustmentApprovalGuard } from './stock-adjustment-approval.guard';
import { WarehouseTransfersController } from './warehouse-transfers.controller';
import { WarehouseTransferService } from './warehouse-transfer.service';
import { StockReservationsController } from './stock-reservations.controller';
import { StockReservationService } from './stock-reservation.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [InventoryController, WarehouseTransfersController, StockReservationsController],
  providers: [InventoryService, WarehouseTransferService, StockReservationService, InventoryWriteRoleGuard, StockAdjustmentApprovalGuard],
})
export class InventoryModule {}
