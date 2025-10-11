import { PartialType } from '@nestjs/mapped-types';
import { CreateDevelopmentPlanRevisionDto } from './create-development-plan-revision.dto';

export class UpdateDevelopmentPlanRevisionDto extends PartialType(CreateDevelopmentPlanRevisionDto) {}
