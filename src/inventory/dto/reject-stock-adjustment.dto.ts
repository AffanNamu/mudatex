import { IsString, MaxLength, MinLength } from 'class-validator';

export class RejectStockAdjustmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
