import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { InventoryController } from './inventory.controller';
import { InventoryWriteRoleGuard } from './inventory-write-role.guard';
import { InventoryService } from './inventory.service';
import { StockAdjustmentApprovalGuard } from './stock-adjustment-approval.guard';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [InventoryController],
  providers: [InventoryService, InventoryWriteRoleGuard, StockAdjustmentApprovalGuard],
})
export class InventoryModule {}
