import { PartialType } from '@nestjs/mapped-types';
import { CreateAmphoeDto } from './create-amphoe.dto';

export class UpdateAmphoeDto extends PartialType(CreateAmphoeDto) {}
