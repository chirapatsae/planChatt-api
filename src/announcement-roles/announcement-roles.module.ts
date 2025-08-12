import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnnouncementRolesService } from './announcement-roles.service';
import { AnnouncementRolesController } from './announcement-roles.controller';
import { AnnouncementRole } from './entities/announcement-role.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AnnouncementRole])],
  controllers: [AnnouncementRolesController],
  providers: [AnnouncementRolesService],
  exports: [AnnouncementRolesService],
})
export class AnnouncementRolesModule {}
