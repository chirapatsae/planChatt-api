import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttachmentRevisedProjectGroupsController } from './attachment-revised-project-groups.controller';
import { AttachmentRevisedProjectGroupsService } from './attachment-revised-project-groups.service';
import { AttachmentRevisedProjectGroup } from './entities/attachment-revised-project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AttachmentRevisedProjectGroup, RevisedProjectGroup])],
  controllers: [AttachmentRevisedProjectGroupsController],
  providers: [AttachmentRevisedProjectGroupsService],
  exports: [AttachmentRevisedProjectGroupsService],
})
export class AttachmentRevisedProjectGroupsModule {}


