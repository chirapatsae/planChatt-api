import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Announcement } from 'src/announcements/entities/announcement.entity';
import { Role } from 'src/roles/entities/role.entity';

@Entity('announcement_roles')
export class AnnouncementRole {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Announcement, (announcement) => announcement.announcementRoles, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'announcement_id' })
  announcement: Announcement;

  @ManyToOne(() => Role, (role) => role.announcementRoles, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'role_id' })
  role: Role;
}
