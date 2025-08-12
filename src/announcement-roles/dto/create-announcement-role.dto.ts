import { IsUUID } from 'class-validator';

export class CreateAnnouncementRoleDto {
  @IsUUID()
  announcementId: string;

  @IsUUID()
  roleId: string;
}
