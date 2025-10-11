import { PartialType } from '@nestjs/mapped-types';
import { CreateRevisionTypeDto } from './create-revision-type.dto';

export class UpdateRevisionTypeDto extends PartialType(CreateRevisionTypeDto) {}
