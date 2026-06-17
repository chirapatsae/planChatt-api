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
    ]),
  ],
  controllers: [ExecutiveController],
  providers: [ExecutiveService],
})
export class ExecutiveModule { }
