import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateDevelopmentIssueDto {
  @IsNotEmpty()
  @IsUUID()
  developmentPlanId: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(512)
  name: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
