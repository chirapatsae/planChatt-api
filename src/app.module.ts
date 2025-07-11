import { Plan } from './plan/entities/plan.entity';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UsersModule } from './users/users.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './users/entities/user.entity';
import { WorkHistoryModule } from './work-history/work-history.module';
import { WorkHistory } from './work-history/entities/work-history.entity';
import { AmphoesModule } from './amphoes/amphoes.module';
import { Amphoe } from './amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from './local-administrative-organizations/entities/local-administrative-organization.entity';
import { LocalAdministrativeOrganizationsModule } from './local-administrative-organizations/local-administrative-organizations.module';
import { StatusModule } from './status/status.module';
import { Status } from './status/entities/status.entity';
import { TrackingStatusModule } from './tracking-status/tracking-status.module';
import { TrackingStatus } from './tracking-status/entities/tracking-status.entity';
import { BudgetPlanModule } from './budget_plan/budget_plan.module';
import { BudgetPlan } from './budget_plan/entities/budget_plan.entity';
import { ProjectGroupsModule } from './project-groups/project-groups.module';
import { ProjectGroup } from './project-groups/entities/project-group.entity';
import { ProjectTypesModule } from './project-types/project-types.module';
import { ProjectType } from './project-types/entities/project-type.entity';
import { BudgetModule } from './budget/budget.module';
import { Budget } from './budget/entities/budget.entity';
import { AuthModule } from './auth/auth.module';
import { StrategyModule } from './strategy/strategy.module';
import { Strategy } from './strategy/entities/strategy.entity';
import { TacticModule } from './tactic/tactic.module';
import { Tactic } from './tactic/entities/tactic.entity';
import { PlanModule } from './plan/plan.module';
import { PlanTactic } from './plan/entities/plan-tactic.entity';
import { PdfModule } from './pdf/pdf.module';
import { ScheduleModule } from '@nestjs/schedule';
import { CommentsModule } from './comments/comments.module';
import { Comment } from './comments/entities/comment.entity';
import { AiController } from './ai/ai.controller';
import { AiService } from './ai/ai.service';
import { AiModule } from './ai/ai.module';
import { WorkHistoryAmphoeResponsibility } from './work-history/entities/work-history-amphoe-responsibility.entity';
import { OnboardingModule } from './onboarding/onboarding.module';
import { RolesModule } from './roles/roles.module';
import { Role } from './roles/entities/role.entity';
import { WorkStatusModule } from './work-status/work-status.module';
import { WorkStatus } from './work-status/entities/work-status.entity';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    UsersModule,
    WorkHistoryModule,
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      password: 'Pao@1234!',
      database: 'project_bank',
      entities: [User,Strategy,Tactic, Plan,PlanTactic,WorkHistoryAmphoeResponsibility, WorkHistory , Amphoe , LocalAdministrativeOrganization , Status ,  TrackingStatus , BudgetPlan , ProjectGroup , ProjectType , Budget , Comment , Role , WorkStatus] ,
      synchronize: true,
    }),
    AmphoesModule,
    LocalAdministrativeOrganizationsModule,
    StatusModule,
    TrackingStatusModule,
    BudgetPlanModule,
    ProjectGroupsModule,
    ProjectTypesModule,
    BudgetModule,
    AuthModule,
    StrategyModule,
    TacticModule,
    PlanModule,
    PdfModule,
    CommentsModule,
    AiModule,
    OnboardingModule,
    RolesModule,
    WorkStatusModule,
    ],
  controllers: [AppController, AiController],
  providers: [AppService, AiService],
})
export class AppModule { }
