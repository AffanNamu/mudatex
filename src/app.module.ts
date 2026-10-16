import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { ProductsModule } from './products/products.module';

@Module({ imports: [DatabaseModule, ProductsModule], controllers: [HealthController] })
export class AppModule {}
