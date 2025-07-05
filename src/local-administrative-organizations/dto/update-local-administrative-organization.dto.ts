import { PartialType } from '@nestjs/mapped-types';
import { CreateLocalAdministrativeOrganizationDto } from './create-local-administrative-organization.dto';

export class UpdateLocalAdministrativeOrganizationDto extends PartialType(CreateLocalAdministrativeOrganizationDto) {}
