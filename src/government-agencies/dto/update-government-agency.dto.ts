import { PartialType } from '@nestjs/mapped-types';
import { CreateGovernmentAgencyDto } from './create-government-agency.dto';

export class UpdateGovernmentAgencyDto extends PartialType(CreateGovernmentAgencyDto) {} 