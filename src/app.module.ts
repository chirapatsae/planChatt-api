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
import { RolesModule } from './roles/roles.module';
import { Role } from './roles/entities/role.entity';
import { WorkStatusModule } from './work-status/work-status.module';
import { WorkStatus } from './work-status/entities/work-status.entity';
import { PositionsModule } from './positions/positions.module';
import { Position } from './positions/entities/position.entity';
import { GovernmentAgenciesModule } from './government-agencies/government-agencies.module';
import { GovernmentAgency } from './government-agencies/entities/government-agency.entity';
import { WorkHistoryAmphoeResponsibilityModule } from './work-history-amphoe-responsibility/work-history-amphoe-responsibility.module';
import { WorkHistoryAmphoeResponsibility } from './work-history-amphoe-responsibility/entities/work-history-amphoe-responsibility.entity';
import { UserActivityLogsModule } from './user-activity-logs/user-activity-logs.module';
import { AiUsageQuotasModule } from './ai-usage-quotas/ai-usage-quotas.module';
import { UserActivityLog } from './user-activity-logs/entities/user-activity-log.entity';
import { AiUsageQuota } from './ai-usage-quotas/entities/ai-usage-quota.entity';
import { AiUsageLogsModule } from './ai-usage-logs/ai-usage-logs.module';

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
      entities: [
        User,
        UserActivityLog,
        Strategy,
        Tactic,
        Plan,
        PlanTactic,
        WorkHistoryAmphoeResponsibility,
        WorkHistory,
        Amphoe,
        LocalAdministrativeOrganization,
        Status,
        TrackingStatus,
        BudgetPlan,
        ProjectGroup,
        Budget,
        Comment,
        Role,
        WorkStatus,
        Position,
        GovernmentAgency,
        AiUsageQuota
      ],
      synchronize: true,
    }),
    AmphoesModule,
    LocalAdministrativeOrganizationsModule,
    StatusModule,
    TrackingStatusModule,
    BudgetPlanModule,
    ProjectGroupsModule,
    BudgetModule,
    AuthModule,
    StrategyModule,
    TacticModule,
    PlanModule,
    PdfModule,
    CommentsModule,
    AiModule,
    RolesModule,
    WorkStatusModule,
    PositionsModule,
    GovernmentAgenciesModule,
    WorkHistoryAmphoeResponsibilityModule,
    UserActivityLogsModule,
    AiUsageQuotasModule,
    AiUsageLogsModule,
  ],
  controllers: [AppController, AiController],
  providers: [AppService, AiService],
})
export class AppModule {}
