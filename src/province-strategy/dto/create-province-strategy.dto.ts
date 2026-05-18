import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateProvinceStrategyDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  nameTh: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  nameEn?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
