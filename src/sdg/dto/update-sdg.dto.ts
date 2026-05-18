import { PartialType } from '@nestjs/mapped-types';
import { CreateSdgDto } from './create-sdg.dto';

export class UpdateSdgDto extends PartialType(CreateSdgDto) {}
