import { IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export class ReceiveStockDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  locationId!: string;

  // Decimal string avoids binary floating-point rounding before PostgreSQL Decimal(20, 6).
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/, {
    message: 'quantity must be a positive decimal with at most 14 integer and 6 fractional digits',
  })
  quantity!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  idempotencyKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
