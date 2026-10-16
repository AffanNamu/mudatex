import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ProductsController } from './products.controller';
import { ProductWriteRoleGuard } from './product-write-role.guard';
import { ProductsService } from './products.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [ProductsController],
  providers: [ProductsService, ProductWriteRoleGuard],
})
export class ProductsModule {}
