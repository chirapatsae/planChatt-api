import { PartialType } from '@nestjs/mapped-types';
import { CreateRevisedProjectGroupDto } from './create-revised-project-group.dto';

export class UpdateRevisedProjectGroupDto extends PartialType(CreateRevisedProjectGroupDto) {}
