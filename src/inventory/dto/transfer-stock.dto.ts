import { IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export class TransferStockDto {
  @IsUUID()
  productId!: string;
  @IsUUID()
  sourceLocationId!: string;
  @IsUUID()
  destinationLocationId!: string;
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/, { message: 'quantity must be positive with at most 6 decimal places' })
  quantity!: string;
  @IsString()
  @MinLength(1)
  @MaxLength(118)
  idempotencyKey!: string;
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
