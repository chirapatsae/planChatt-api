import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttachmentProjectGroupsController } from './attachment-project-groups.controller';
import { AttachmentProjectGroupsService } from './attachment-project-groups.service';
import { AttachmentProjectGroup } from './entities/attachment-project-group.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AttachmentProjectGroup, ProjectGroup])],
  controllers: [AttachmentProjectGroupsController],
  providers: [AttachmentProjectGroupsService],
  exports: [AttachmentProjectGroupsService],
})
export class AttachmentProjectGroupsModule {}


