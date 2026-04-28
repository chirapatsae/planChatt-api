import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttachmentProjectGroupsController } from './attachment-project-groups.controller';
import { AttachmentProjectGroupsService } from './attachment-project-groups.service';
import { AttachmentProjectGroup } from './entities/attachment-project-group.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { DocumentAnalysisModule } from 'src/document-analysis/document-analysis.module';
// Wave 44 / BE-W44-03 — import AiUsageQuotasModule so AiQuotaGuard is
// resolvable from the staff-lead retry endpoint.
import { AiUsageQuotasModule } from 'src/ai-usage-quotas/ai-usage-quotas.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AttachmentProjectGroup, ProjectGroup]),
    DocumentAnalysisModule,
    AiUsageQuotasModule,
  ],
  controllers: [AttachmentProjectGroupsController],
  providers: [AttachmentProjectGroupsService],
  exports: [AttachmentProjectGroupsService],
})
export class AttachmentProjectGroupsModule {}
