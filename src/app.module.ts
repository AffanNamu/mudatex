import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { InventoryModule } from './inventory/inventory.module';
import { ProductsModule } from './products/products.module';

@Module({ imports: [DatabaseModule, ProductsModule, InventoryModule], controllers: [HealthController] })
export class AppModule {}
