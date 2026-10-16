import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class WarehouseTransferReceiptLineInput {
  @IsUUID()
  productId!: string;

  // Cumulative quantity received to date, not the quantity in this individual delivery.
  @IsString()
  @Matches(/^(?:0|[1-9][0-9]{0,13})(?:[.][0-9]{1,6})?$/, { message: 'quantityReceived must be non-negative with at most 6 decimal places' })
  quantityReceived!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  discrepancyReason?: string;
}

export class ReceiveWarehouseTransferDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique((line: WarehouseTransferReceiptLineInput) => line.productId)
  @ValidateNested({ each: true })
  @Type(() => WarehouseTransferReceiptLineInput)
  lines!: WarehouseTransferReceiptLineInput[];
}
