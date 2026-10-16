import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class WarehouseTransferLineInput {
  @IsUUID()
  productId!: string;

  @IsString()
  @Matches(/^(?:0|[1-9][0-9]{0,13})(?:[.][0-9]{1,6})?$/, { message: 'quantity must be positive with at most 6 decimal places' })
  quantity!: string;
}

export class CreateWarehouseTransferDto {
  @IsUUID()
  sourceLocationId!: string;

  @IsUUID()
  destinationLocationId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique((line: WarehouseTransferLineInput) => line.productId)
  @ValidateNested({ each: true })
  @Type(() => WarehouseTransferLineInput)
  lines!: WarehouseTransferLineInput[];

  @IsString()
  @MinLength(1)
  @MaxLength(118)
  idempotencyKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
