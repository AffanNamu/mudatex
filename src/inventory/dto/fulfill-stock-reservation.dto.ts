import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';

export class FulfillStockReservationLineDto {
  @IsUUID()
  productId!: string;

  @IsString()
  @Matches(/^[0-9]+(?:[.][0-9]{1,6})?$/, { message: 'quantity must be a positive decimal with at most 6 fractional digits' })
  quantity!: string;
}

export class FulfillStockReservationDto {
  @IsString()
  @MaxLength(200)
  idempotencyKey!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => FulfillStockReservationLineDto)
  lines!: FulfillStockReservationLineDto[];
}
