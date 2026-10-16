import { IsOptional, IsUUID } from 'class-validator';

export class ListStockBalancesQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;
  @IsOptional()
  @IsUUID()
  productId?: string;
}
