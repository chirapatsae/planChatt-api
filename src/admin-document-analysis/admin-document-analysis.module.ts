import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttachmentProjectGroup } from 'src/attachment-project-groups/entities/attachment-project-group.entity';
import { AttachmentRevisedProjectGroup } from 'src/attachment-revised-project-groups/entities/attachment-revised-project-group.entity';
import { DocumentAnalysisModule } from 'src/document-analysis/document-analysis.module';
import { AdminDocumentAnalysisController } from './admin-document-analysis.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AttachmentProjectGroup,
      AttachmentRevisedProjectGroup,
    ]),
    DocumentAnalysisModule,
  ],
  controllers: [AdminDocumentAnalysisController],
})
export class AdminDocumentAnalysisModule {}
