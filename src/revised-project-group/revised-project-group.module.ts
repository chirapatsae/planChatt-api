import { Module } from '@nestjs/common';
import { RevisedProjectGroupService } from './revised-project-group.service';
import { RevisedProjectGroupController } from './revised-project-group.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RevisedProjectGroup } from './entities/revised-project-group.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Budget } from 'src/budget/entities/budget.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RevisedProjectGroup,
      DevelopmentPlanRevision,
      ProjectGroup,
      BudgetPlan,
      Strategy,
      Tactic,
      Plan,
      WorkHistory,
      Budget,
    ]),
  ],
  controllers: [RevisedProjectGroupController],
  providers: [RevisedProjectGroupService],
  exports: [RevisedProjectGroupService],
})
export class RevisedProjectGroupModule {}
