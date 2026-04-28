import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttachmentRevisedProjectGroupsController } from './attachment-revised-project-groups.controller';
import { AttachmentRevisedProjectGroupsService } from './attachment-revised-project-groups.service';
import { AttachmentRevisedProjectGroup } from './entities/attachment-revised-project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { DocumentAnalysisModule } from 'src/document-analysis/document-analysis.module';
// Wave 44 / BE-W44-03 — import AiUsageQuotasModule so AiQuotaGuard is
// resolvable from the staff-lead retry endpoint.
import { AiUsageQuotasModule } from 'src/ai-usage-quotas/ai-usage-quotas.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AttachmentRevisedProjectGroup, RevisedProjectGroup]),
    DocumentAnalysisModule,
    AiUsageQuotasModule,
  ],
  controllers: [AttachmentRevisedProjectGroupsController],
  providers: [AttachmentRevisedProjectGroupsService],
  exports: [AttachmentRevisedProjectGroupsService],
})
export class AttachmentRevisedProjectGroupsModule {}
