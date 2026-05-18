import { PartialType } from '@nestjs/mapped-types';
import { CreateNationalStrategyDto } from './create-national-strategy.dto';

export class UpdateNationalStrategyDto extends PartialType(
  CreateNationalStrategyDto,
) {}
