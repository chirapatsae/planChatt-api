import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EquipmentProjectGroup } from './entities/equipment-project-group.entity';
import { EquipmentProjectGroupService } from './equipment-project-group.service';
import { EquipmentProjectGroupController } from './equipment-project-group.controller';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Status } from 'src/status/entities/status.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { EquipmentCategory } from 'src/equipment-category/entities/equipment-category.entity';
import { EquipmentCategoryScope } from 'src/equipment-category/entities/equipment-category-scope.entity';
import { PlanPhase } from 'src/plan-phase/entities/plan-phase.entity';

import { ProjectClassificationModule } from 'src/common/project-classification/project-classification.module';
import { WorkHistoryModule } from 'src/work-history/work-history.module';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { AgencyOnlyGuard } from 'src/common/guards/agency-only.guard';
// Wave Print ผ.03 — BE-02 (2026-05-28). Layer-1 controller guard for
// the user-side print endpoint `POST /v1/pdf/generate-por03`. Registered
// + exported here so BE-01 (PdfModule) can `@UseGuards()` it without
// duplicating the `WorkHistory` repo wiring.
import { PrintPor03AgencyGuard } from './guards/print-por03-agency.guard';
// Wave Equipment ผ.03 Phase 2 — BE-06 (2026-05-28). Service depends on
// `PreSubmitSnapshotService` to fire the §17.4 `no-ai-baseline` row at
// equipment publish (Ready → Pending). AiModule exports it.
import { AiModule } from 'src/ai/ai.module';

/**
 * Wave Equipment ผ.03, Phase 2 — DB-02 + BE-04 (2026-05-28).
 *
 * Owns the equipment-item CRUD + workflow integration surface.
 *
 * Imports cover every entity the service touches inside its
 * transactions. The `manager.findOne(Entity, ...)` calls bypass the
 * injected repository, but TypeORM still needs the entity metadata
 * resolvable from this module's `forFeature` (plus the root
 * `entities[]` registration in `app.module.ts` — Wave 41 footgun).
 *
 * - `WorkHistory` — required by `WorkStatusApprovedGuard` and
 *   `AgencyOnlyGuard` (both injected here).
 * - `ProjectClassificationModule` — exports `BookFormatResolver` and
 *   `ProjectClassificationValidator` used by the service.
 * - `WorkHistoryModule` — exports `WorkHistoryLookupService` used by
 *   the service for §1 / §2 lookups.
 *
 * Budget storage decision: the existing `Budget` entity
 * (`backend/src/budget/entities/budget.entity.ts`) was already
 * polymorphic across PG / RPG / SPG via three nullable FK columns. We
 * extended the same pattern with a fourth nullable FK
 * (`equipment_project_group_id`) instead of creating a parallel
 * `equipment_project_group_budgets` table. Rationale:
 * - Zero schema duplication, zero divergent budget logic.
 * - Reuses every existing Budget query / aggregation surface (PDF,
 *   executive analytics, public archive) the moment they branch on
 *   the new FK.
 * - Matches the convention already established for the previous three
 *   project siblings.
 * The fourth FK is wired entirely on the existing `Budget` entity;
 * no new entity is registered here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      EquipmentProjectGroup,
      WorkHistory,
      Status,
      TrackingStatus,
      Budget,
      DevelopmentPlan,
      DevelopmentIssue,
      Strategy,
      Tactic,
      Plan,
      EquipmentCategory,
      EquipmentCategoryScope,
      PlanPhase,
    ]),
    ProjectClassificationModule,
    WorkHistoryModule,
    AiModule,
  ],
  controllers: [EquipmentProjectGroupController],
  providers: [
    EquipmentProjectGroupService,
    WorkStatusApprovedGuard,
    AgencyOnlyGuard,
    // Wave Print ผ.03 BE-02 — exported so BE-01's PdfModule (or any
    // downstream consumer that imports `EquipmentProjectGroupModule`)
    // can mount the guard via `@UseGuards(PrintPor03AgencyGuard)`
    // without re-declaring the `WorkHistory` repo dependency.
    PrintPor03AgencyGuard,
  ],
  exports: [
    TypeOrmModule,
    EquipmentProjectGroupService,
    // Wave Print ผ.03 BE-02 — re-export so consumers see the provider.
    PrintPor03AgencyGuard,
  ],
})
export class EquipmentProjectGroupModule {}
