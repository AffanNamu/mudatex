import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { MudatexRequest } from '../auth/authenticated-request';
import { OidcAuthGuard } from '../auth/oidc-auth.guard';
import { OrganizationScopeGuard } from '../auth/organization-scope.guard';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { ProductWriteRoleGuard } from './product-write-role.guard';
import { ProductsService } from './products.service';

@Controller('products')
@UseGuards(OidcAuthGuard, OrganizationScopeGuard)
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@Req() request: MudatexRequest, @Query() query: ListProductsQueryDto) {
    return this.products.list(request.organizationAccess!.organizationId, query);
  }

  @Post()
  @UseGuards(ProductWriteRoleGuard)
  create(@Req() request: MudatexRequest, @Body() input: CreateProductDto) {
    return this.products.create(
      request.organizationAccess!.organizationId,
      request.principal!,
      input,
    );
  }
}
