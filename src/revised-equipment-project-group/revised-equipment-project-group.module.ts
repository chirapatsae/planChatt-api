import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RevisedEquipmentProjectGroup } from './entities/revised-equipment-project-group.entity';
import { RevisedEquipmentProjectGroupService } from './revised-equipment-project-group.service';
import { RevisedEquipmentProjectGroupController } from './revised-equipment-project-group.controller';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Status } from 'src/status/entities/status.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { EquipmentCategory } from 'src/equipment-category/entities/equipment-category.entity';
import { EquipmentCategoryScope } from 'src/equipment-category/entities/equipment-category-scope.entity';

import { ProjectClassificationModule } from 'src/common/project-classification/project-classification.module';
import { WorkHistoryModule } from 'src/work-history/work-history.module';
import { LineageLockModule } from 'src/common/lineage-lock/lineage-lock.module';
import { UsersModule } from 'src/users/users.module';
import { AiModule } from 'src/ai/ai.module';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { AgencyOnlyGuard } from 'src/common/guards/agency-only.guard';

/**
 * Wave Equipment Revision Management — DB-01 (skeleton) + BE-01 (service +
 * controller).
 *
 * Owns the RELPG (RevisedEquipmentProjectGroup) CRUD + workflow + audit
 * surface. Mirrors `EquipmentProjectGroupModule` for the dependency
 * topology, adding `LineageLockModule` (the §14 fork-lock check) and
 * `DevelopmentPlanRevision` / `EquipmentProjectGroup` to the
 * `forFeature` list (resolved via `manager.findOne` inside the service's
 * transactions).
 *
 * NOTE (Wave 41 footgun): `forFeature` here provides the repo token, but
 * each entity metadata MUST also be listed in the root `entities[]` list
 * in `app.module.ts` or TypeORM throws `EntityMetadataNotFoundError` at
 * boot. The RELPG entity is already registered there (DB-01).
 *
 * The service is EXPORTED so BE-02 can extend it with staff review
 * transitions (verify / approve / return / rollback).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      RevisedEquipmentProjectGroup,
      WorkHistory,
      Status,
      TrackingStatus,
      Budget,
      DevelopmentPlanRevision,
      DevelopmentIssue,
      EquipmentProjectGroup,
      Strategy,
      Tactic,
      Plan,
      EquipmentCategory,
      EquipmentCategoryScope,
    ]),
    ProjectClassificationModule,
    WorkHistoryModule,
    LineageLockModule,
    AiModule,
    UsersModule,
  ],
  controllers: [RevisedEquipmentProjectGroupController],
  providers: [
    RevisedEquipmentProjectGroupService,
    WorkStatusApprovedGuard,
    AgencyOnlyGuard,
  ],
  exports: [TypeOrmModule, RevisedEquipmentProjectGroupService],
})
export class RevisedEquipmentProjectGroupModule {}
