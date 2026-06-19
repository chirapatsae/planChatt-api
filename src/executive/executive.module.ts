import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExecutiveService } from './executive.service';
import { ExecutiveController } from './executive.controller';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
// Equipment sub-types (ครุภัณฑ์ ผ.03) — registered here for `forFeature`
// repo injection only (DB-01, wave-team-dashboard-equipment-coverage). The
// entities themselves are already registered globally by their owning
// modules in `app.module.ts`; no migration / DDL is involved.
import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { SupplementEquipmentProjectGroup } from 'src/supplement-equipment-project-group/entities/supplement-equipment-project-group.entity';
// Round-window source entities (wave-team-dashboard-scope-window) —
// registered for read-only repo injection so `getTeamDashboard` can derive
// the §8 PlanPhase window (main) and the §9 DPR / DPS window (revision /
// change / supplement). Entities are already registered globally by their
// owning modules; no migration / DDL — these are READ-ONLY queries (§17.2).
import { PlanPhase } from 'src/plan-phase/entities/plan-phase.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorkHistory,
      ProjectGroup,
      DevelopmentPlan,
      RevisedProjectGroup,
      SupplementProjectGroup,
      EquipmentProjectGroup,
      RevisedEquipmentProjectGroup,
      SupplementEquipmentProjectGroup,
      PlanPhase,
      DevelopmentPlanRevision,
      DevelopmentPlanSupplement,
    ]),
  ],
  controllers: [ExecutiveController],
  providers: [ExecutiveService],
})
export class ExecutiveModule { }
