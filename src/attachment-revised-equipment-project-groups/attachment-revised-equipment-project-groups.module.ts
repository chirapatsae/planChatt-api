import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttachmentRevisedEquipmentProjectGroupsController } from './attachment-revised-equipment-project-groups.controller';
import { AttachmentRevisedEquipmentProjectGroupsService } from './attachment-revised-equipment-project-groups.service';
import { AttachmentRevisedEquipmentProjectGroup } from './entities/attachment-revised-equipment-project-group.entity';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { AgencyOnlyGuard } from 'src/common/guards/agency-only.guard';

/**
 * Wave Equipment Revision Management — attachment support for RELPG.
 *
 * Clone of `AttachmentRevisedProjectGroupsModule` with the
 * `DocumentAnalysisModule` / `AiUsageQuotasModule` dependencies dropped (no
 * AI document-analysis for equipment in this wave). `WorkHistory` is
 * registered in `forFeature` so the route-mounted `WorkStatusApprovedGuard`
 * + `AgencyOnlyGuard` can inject the WorkHistory repository.
 *
 * NOTE: the `AttachmentRevisedEquipmentProjectGroup` entity metadata MUST
 * also be listed in the root `entities[]` array in `app.module.ts` or
 * TypeORM throws `EntityMetadataNotFoundError` at boot.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AttachmentRevisedEquipmentProjectGroup,
      RevisedEquipmentProjectGroup,
      WorkHistory,
    ]),
  ],
  controllers: [AttachmentRevisedEquipmentProjectGroupsController],
  providers: [
    AttachmentRevisedEquipmentProjectGroupsService,
    WorkStatusApprovedGuard,
    AgencyOnlyGuard,
  ],
  exports: [AttachmentRevisedEquipmentProjectGroupsService],
})
export class AttachmentRevisedEquipmentProjectGroupsModule {}
