import { PartialType } from '@nestjs/mapped-types';
import { CreateTacticDto } from './create-tactic.dto';

export class UpdateTacticDto extends PartialType(CreateTacticDto) {}
