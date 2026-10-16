import { ArrayMaxSize, ArrayUnique, IsArray, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateCycleCountDto {
  @IsUUID()
  locationId!: string;

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  productIds!: string[];

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  idempotencyKey!: string;
}
