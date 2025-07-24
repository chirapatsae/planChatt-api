import {
  IsNotEmpty,
  IsNumber,
  IsUUID,
  IsInt,
  IsOptional,
} from 'class-validator';

export class CreateBudgetDto {
  @IsUUID()
  @IsOptional()
  projectGroupId?: string;

  @IsUUID()
  @IsOptional()
  projectVersionId?: number;

  @IsInt()
  year: number;

  @IsNumber()
  @IsOptional()
  quantity: number;
}
