import { PartialType } from '@nestjs/mapped-types';
import { CreateProjectGroupDto } from './create-project-group.dto';

export class UpdateProjectGroupDto extends PartialType(CreateProjectGroupDto) {}
