import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttachmentRevisedProjectGroupsController } from './attachment-revised-project-groups.controller';
import { AttachmentRevisedProjectGroupsService } from './attachment-revised-project-groups.service';
import { AttachmentRevisedProjectGroup } from './entities/attachment-revised-project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { DocumentAnalysisModule } from 'src/document-analysis/document-analysis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AttachmentRevisedProjectGroup, RevisedProjectGroup]),
    DocumentAnalysisModule,
  ],
  controllers: [AttachmentRevisedProjectGroupsController],
  providers: [AttachmentRevisedProjectGroupsService],
  exports: [AttachmentRevisedProjectGroupsService],
})
export class AttachmentRevisedProjectGroupsModule {}
