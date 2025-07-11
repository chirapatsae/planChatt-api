import { PartialType } from '@nestjs/mapped-types';
import { CreateWorkStatusDto } from './create-work-status.dto';

export class UpdateWorkStatusDto extends PartialType(CreateWorkStatusDto) {}
