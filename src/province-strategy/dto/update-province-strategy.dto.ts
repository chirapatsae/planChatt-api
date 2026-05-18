import { PartialType } from '@nestjs/mapped-types';
import { CreateProvinceStrategyDto } from './create-province-strategy.dto';

export class UpdateProvinceStrategyDto extends PartialType(
  CreateProvinceStrategyDto,
) {}
