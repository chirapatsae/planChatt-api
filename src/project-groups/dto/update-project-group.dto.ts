import { PartialType } from '@nestjs/mapped-types';
import { CreateProjectGroupDto } from './create-project-group.dto';
import { IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateBudgetDto } from 'src/budget/dto/create-budget.dto';

export class UpdateProjectGroupDto extends PartialType(CreateProjectGroupDto) {
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateBudgetDto)
  budget?: CreateBudgetDto[];
}
