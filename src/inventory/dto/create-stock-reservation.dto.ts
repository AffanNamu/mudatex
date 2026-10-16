import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';

export class StockReservationLineDto {
  @IsUUID()
  productId!: string;

  @IsString()
  @Matches(/^[0-9]+(?:[.][0-9]{1,6})?$/, { message: 'quantity must be a positive decimal with at most 6 fractional digits' })
  quantity!: string;
}

export class CreateStockReservationDto {
  @IsUUID()
  locationId!: string;

  @IsString()
  @MaxLength(120)
  orderReference!: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsString()
  @MaxLength(200)
  idempotencyKey!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => StockReservationLineDto)
  lines!: StockReservationLineDto[];
}
