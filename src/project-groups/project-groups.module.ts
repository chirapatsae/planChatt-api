import { Module } from '@nestjs/common';
import { ProjectGroupsService } from './project-groups.service';
import { ProjectGroupsController } from './project-groups.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectGroup } from './entities/project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { User } from 'src/users/entities/user.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProjectGroup,
      WorkHistory,
      User,
      Budget,
      Strategy,
      Tactic,
      Plan,
      BudgetPlan,
      TrackingStatus,
      RevisedProjectGroup,
      DevelopmentPlanRevision,
    ]),
  ],
  controllers: [ProjectGroupsController],
  providers: [ProjectGroupsService],
})
export class ProjectGroupsModule {}
