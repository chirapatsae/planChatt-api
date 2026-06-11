import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SupplementEquipmentProjectGroup } from './entities/supplement-equipment-project-group.entity';
import { SupplementEquipmentProjectGroupService } from './supplement-equipment-project-group.service';
import { SupplementEquipmentProjectGroupController } from './supplement-equipment-project-group.controller';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Status } from 'src/status/entities/status.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { EquipmentCategory } from 'src/equipment-category/entities/equipment-category.entity';
import { EquipmentCategoryScope } from 'src/equipment-category/entities/equipment-category-scope.entity';

import { ProjectClassificationModule } from 'src/common/project-classification/project-classification.module';
import { WorkHistoryModule } from 'src/work-history/work-history.module';
import { BookLockModule } from 'src/common/book-lock/book-lock.module';
import { UsersModule } from 'src/users/users.module';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { AgencyOnlyGuard } from 'src/common/guards/agency-only.guard';
// §17.4 — `PreSubmitSnapshotService` fires the `no-ai-baseline` row at
// the SEPG publish path (Ready → Pending). AiModule exports it.
import { AiModule } from 'src/ai/ai.module';

/**
 * Wave wave-supplement-equipment-por03 — BE-B1 (2026-06-08).
 *
 * Owns the supplement-equipment-item CRUD surface. Mirrors
 * `EquipmentProjectGroupModule` with the book parent swapped to
 * `DevelopmentPlanSupplement` (§10) and the §15.4 book lock provided via
 * `BookLockModule` (instead of `LineageLockModule` — §14 is vacuous in
 * v1 per OQ-B3, so no lineage-lock dependency is needed).
 *
 * Imports cover every entity the service touches inside its
 * transactions. The `manager.findOne(Entity, ...)` calls bypass the
 * injected repository, but TypeORM still needs the entity metadata
 * resolvable from this module's `forFeature` (plus the root `entities[]`
 * registration in `app.module.ts`).
 *
 * Budget storage reuses the polymorphic `Budget` entity (the
 * `supplement_equipment_project_group_id` nullable FK added in DB-B1) —
 * no new budget table.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SupplementEquipmentProjectGroup,
      WorkHistory,
      Status,
      TrackingStatus,
      Budget,
      DevelopmentPlan,
      DevelopmentPlanSupplement,
      DevelopmentIssue,
      Strategy,
      Tactic,
      Plan,
      EquipmentCategory,
      EquipmentCategoryScope,
    ]),
    ProjectClassificationModule,
    WorkHistoryModule,
    BookLockModule,
    AiModule,
    UsersModule,
  ],
  controllers: [SupplementEquipmentProjectGroupController],
  providers: [
    SupplementEquipmentProjectGroupService,
    WorkStatusApprovedGuard,
    AgencyOnlyGuard,
  ],
  exports: [TypeOrmModule, SupplementEquipmentProjectGroupService],
})
export class SupplementEquipmentProjectGroupModule {}
