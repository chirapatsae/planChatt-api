import { Plan } from './plan/entities/plan.entity';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
import { DevelopmentPlanModule } from './development-plan/development-plan.module';
import { DevelopmentPlan } from './development-plan/entities/development-plan.entity';
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
import { BullModule } from '@nestjs/bull';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CommentsModule } from './comments/comments.module';
import { Comment } from './comments/entities/comment.entity';
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
import { WorkHistoryGovernmentAgencyResponsibilityModule } from './work-history-government-agency-responsibility/work-history-government-agency-responsibility.module';
import { WorkHistoryGovernmentAgencyResponsibility } from './work-history-government-agency-responsibility/entities/work-history-government-agency-responsibility.entity';
import { UserActivityLogsModule } from './user-activity-logs/user-activity-logs.module';
import { AiUsageQuotasModule } from './ai-usage-quotas/ai-usage-quotas.module';
import { UserActivityLog } from './user-activity-logs/entities/user-activity-log.entity';
import { AiUsageQuota } from './ai-usage-quotas/entities/ai-usage-quota.entity';
import { AiUsageLogsModule } from './ai-usage-logs/ai-usage-logs.module';
import { AiUsageLog } from './ai-usage-logs/entities/ai-usage-log.entity';
import { ProjectTypesModule } from './project-types/project-types.module';
import { ProjectType } from './project-types/entities/project-type.entity';
import { AnnouncementsModule } from './announcements/announcements.module';
import { Announcement } from './announcements/entities/announcement.entity';
import { AnnouncementRolesModule } from './announcement-roles/announcement-roles.module';
import { AnnouncementRole } from './announcement-roles/entities/announcement-role.entity';
import { NotificationLogsModule } from './notification-logs/notification-logs.module';
import { NotificationLog } from './notification-logs/entities/notification-log.entity';
import { NotificationsModule } from './notifications/notifications.module';
import { UserNotificationsModule } from './user-notifications/user-notifications.module';
import { UserNotification } from './user-notifications/entities/user-notification.entity';
import { WebsocketModule } from './websocket/websocket.module';
import { EventsModule } from './events/events.module';
import { Event } from './events/entities/event.entity';
import { AttachmentEventModule } from './attachment-event/attachment-event.module';
import { AttachmentEvent } from './attachment-event/entities/attachment-event.entity';
import { FavoriteModule } from './favorite/favorite.module';
import { Favorite } from './favorite/entities/favorite.entity';
import { PdfDevelopmentPlanDraftAgencyDocument } from './pdf/entities/pdf-development-plan-draft-agency-document.entity';
import { PdfRevisionEditDraftDocument } from './pdf/entities/pdf-revision-edit-draft-document.entity';
import { PdfRevisionChangeDraftDocument } from './pdf/entities/pdf-revision-change-draft-document.entity';
import { PdfDevelopmentPlanApprovedDocument } from './pdf/entities/pdf-development-plan-approved-document.entity';
import { PdfDevelopmentPlanDraftCoordinateDocument } from './pdf/entities/pdf-development-plan-draft-coordinate-document.entity';
import { PdfOutAuthorityDocument } from './pdf/entities/pdf-out-authority-document.entity';
import { PdfRevisionChangeApprovedDocument } from './pdf/entities/pdf-revision-change-approved-document.entity';
import { PdfRevisionEditApprovedDocument } from './pdf/entities/pdf-revision-edit-approved-document.entity';
import { EmailModule } from './util/email/email.module';
import { RevisionTypeModule } from './revision-type/revision-type.module';
import { RevisionType } from './revision-type/entities/revision-type.entity';
import { DevelopmentPlanRevisionModule } from './development-plan-revision/development-plan-revision.module';
import { DevelopmentPlanRevision } from './development-plan-revision/entities/development-plan-revision.entity';
import { RevisedProjectGroupModule } from './revised-project-group/revised-project-group.module';
import { RevisedProjectGroup } from './revised-project-group/entities/revised-project-group.entity';
import { DevelopmentPlanSupplementModule } from './development-plan-supplement/development-plan-supplement.module';
import { DevelopmentPlanSupplement } from './development-plan-supplement/entities/development-plan-supplement.entity';
import { SupplementProjectGroupModule } from './supplement-project-group/supplement-project-group.module';
import { SupplementProjectGroup } from './supplement-project-group/entities/supplement-project-group.entity';
import { ExecutiveModule } from './executive/executive.module';
import { PlanPhaseModule } from './plan-phase/plan-phase.module';
import { PlanPhase } from './plan-phase/entities/plan-phase.entity';
import { AttachmentProjectGroupsModule } from './attachment-project-groups/attachment-project-groups.module';
import { AttachmentProjectGroup } from './attachment-project-groups/entities/attachment-project-group.entity';
import { AttachmentRevisedProjectGroupsModule } from './attachment-revised-project-groups/attachment-revised-project-groups.module';
import { AttachmentRevisedProjectGroup } from './attachment-revised-project-groups/entities/attachment-revised-project-group.entity';
import { BookAssemblyModule } from './book-assembly/book-assembly.module';
import { BookAssemblyDraft } from './book-assembly/entities/book-assembly-draft.entity';
import { BookAssemblyVersion } from './book-assembly/entities/book-assembly-version.entity';
import { DeprecationAuditLog } from './book-assembly/entities/deprecation-audit-log.entity';
import { BookProjectLineage } from './book-assembly/entities/book-project-lineage.entity';
import { DevelopmentIssueModule } from './development-issue/development-issue.module';
import { DevelopmentIssue } from './development-issue/entities/development-issue.entity';


@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        `.env.${process.env.NODE_ENV}`,
        '.env',
      ],
    }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    BullModule.forRoot({
      redis: {
        host: 'localhost',
        port: 6379,
      },
    }),
    UsersModule,
    WorkHistoryModule,
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 5432,
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      entities: [
        User,
        UserActivityLog,
        Strategy,
        Tactic,
        Plan,
        PlanTactic,
        WorkHistoryAmphoeResponsibility,
        WorkHistoryGovernmentAgencyResponsibility,
        WorkHistory,
        Amphoe,
        LocalAdministrativeOrganization,
        Status,
        TrackingStatus,
        DevelopmentPlan,
        ProjectGroup,
        Budget,
        Comment,
        Role,
        WorkStatus,
        Position,
        GovernmentAgency,
        AiUsageQuota,
        AiUsageLog,
        ProjectType,
        Announcement,
        AnnouncementRole,
        NotificationLog,
        UserNotification,
        Event,
        AttachmentEvent,
        Favorite,
        PdfDevelopmentPlanApprovedDocument,
        PdfRevisionEditDraftDocument,
        PdfRevisionChangeDraftDocument,
        PdfDevelopmentPlanDraftAgencyDocument,
        PdfDevelopmentPlanDraftCoordinateDocument,
        PdfOutAuthorityDocument,
        PdfRevisionEditApprovedDocument,
        PdfRevisionChangeApprovedDocument,
        RevisionType,
        DevelopmentPlanRevision,
        RevisedProjectGroup,
        DevelopmentPlanSupplement,
        SupplementProjectGroup,
        PlanPhase,
        AttachmentProjectGroup,
        AttachmentRevisedProjectGroup,
        BookAssemblyDraft,
        BookAssemblyVersion,
        DeprecationAuditLog,
        BookProjectLineage,
        DevelopmentIssue,
      ],
      synchronize: true,
      extra: {
        query_timeout: 60000,
        connectionTimeoutMillis: 30000,
        acquireTimeoutMillis: 30000,
        idleTimeoutMillis: 30000,
      },
    }),
    AmphoesModule,
    LocalAdministrativeOrganizationsModule,
    StatusModule,
    TrackingStatusModule,
    DevelopmentPlanModule,
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
    WorkHistoryGovernmentAgencyResponsibilityModule,
    UserActivityLogsModule,
    AiUsageQuotasModule,
    AiUsageLogsModule,
    ProjectTypesModule,
    AnnouncementsModule,
    AnnouncementRolesModule,
    NotificationLogsModule,
    NotificationsModule,
    UserNotificationsModule,
    WebsocketModule,
    EventsModule,
    AttachmentEventModule,
    FavoriteModule,
    EmailModule,
    RevisionTypeModule,
    DevelopmentPlanRevisionModule,
    RevisedProjectGroupModule,
    DevelopmentPlanSupplementModule,
    SupplementProjectGroupModule,
    ExecutiveModule,
    PlanPhaseModule,
    AttachmentProjectGroupsModule,
    AttachmentRevisedProjectGroupsModule,
    BookAssemblyModule,
    DevelopmentIssueModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
