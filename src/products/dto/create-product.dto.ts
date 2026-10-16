import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateProductDto {
  @IsUUID()
  legalEntityId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  sku!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(240)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  categoryCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  fabricFamily?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  pattern?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  colour?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  widthMm?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  composition?: string;

  @IsUUID()
  baseUomId!: string;

  @IsOptional()
  @IsBoolean()
  lotTracked?: boolean;

  @IsOptional()
  @IsBoolean()
  rollTracked?: boolean;
}
