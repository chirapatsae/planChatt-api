import { PartialType } from '@nestjs/mapped-types';
import { CreateProjectGroupDto } from './create-project-group.dto';
import { IsOptional, ValidateNested, IsNotEmpty, IsString, IsUUID, IsArray } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateBudgetDto } from 'src/budget/dto/create-budget.dto';

export class UpdateProjectGroupDto extends PartialType(CreateProjectGroupDto) {
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateBudgetDto)
  budget?: CreateBudgetDto[];
}

export class BulkAssignAgencyDto {
  @IsNotEmpty()
  @IsString()
  @IsUUID()
  projectId: string;

  @IsNotEmpty()
  @IsString()
  responsibleAgencyId: string;
}

export class BulkAssignAgencyDtoArray {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkAssignAgencyDto)
  items: BulkAssignAgencyDto[];
}
