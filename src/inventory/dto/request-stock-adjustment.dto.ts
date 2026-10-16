import { IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export class RequestStockAdjustmentDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  locationId!: string;

  // Signed delta: positive adds stock; negative removes stock.
  @IsString()
  @Matches(/^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/, {
    message: 'quantityDelta must be a signed decimal with at most 14 integer and 6 fractional digits',
  })
  quantityDelta!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  idempotencyKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
