import { PartialType } from '@nestjs/mapped-types';
import { CreateAnnouncementRoleDto } from './create-announcement-role.dto';

export class UpdateAnnouncementRoleDto extends PartialType(CreateAnnouncementRoleDto) {}
