import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrphanCleanupController } from './orphan-cleanup.controller';
import { OrphanCleanupService } from './orphan-cleanup.service';

import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Status } from 'src/status/entities/status.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { LineageLockModule } from 'src/common/lineage-lock/lineage-lock.module';

/**
 * W110-BE-01 — OrphanCleanupModule
 *
 * Exports `OrphanCleanupService` for cross-module wiring at the 6 frozen
 * trigger surfaces (CLAUDE.md §18.2.1):
 *   - DPR softRemove / generateApprovedBookForEditRevision /
 *     generateApprovedBookForChangeRevision
 *   - DevelopmentPlan softRemove
 *   - DevelopmentPlanSupplement softRemove
 *   - book-assembly merge (Part 3 finalize)
 *   - pdf finalize sites (out-authority + approved-plan)
 *
 * The controller exposes only a read-only preview endpoint — there is NO
 * direct mutation entry point. The cascade only runs as a transactional
 * side-effect of the host book operation per §18 ban on a standalone
 * admin orphan tool.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProjectGroup,
      RevisedProjectGroup,
      SupplementProjectGroup,
      EquipmentProjectGroup,
      RevisedEquipmentProjectGroup,
      TrackingStatus,
      Status,
      WorkHistory,
    ]),
    LineageLockModule,
  ],
  controllers: [OrphanCleanupController],
  providers: [OrphanCleanupService],
  exports: [OrphanCleanupService],
})
export class OrphanCleanupModule {}
