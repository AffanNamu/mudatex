import { IsString, Matches } from 'class-validator';

export class RecordCycleCountLineDto {
  @IsString()
  @Matches(/^(?:0|[1-9][0-9]{0,13})(?:[.][0-9]{1,6})?$/, {
    message: 'countedQuantity must be zero or a positive decimal with at most 14 integer and 6 fractional digits',
  })
  countedQuantity!: string;
}
