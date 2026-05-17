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
import { NotificationsEmailModule } from './notifications/email/notifications-email.module';
// Wave 96 — LINE notification pipeline. Mirrors NotificationsEmailModule
// shape (separate Bull queue `notifications-line`, separate audit table
// `notification_line_logs`, separate per-channel kill-switch flag).
import { NotificationsLineModule } from './notifications/line/notifications-line.module';
// Wave 91 — register Wave 21/22 notification-pipeline entities at the data
// source level. Previously only declared via TypeOrmModule.forFeature() in
// NotificationsEmailModule, which is insufficient when forRoot uses an
// explicit `entities: [...]` list instead of `autoLoadEntities: true`. Without
// this registration, every queueEmail / kill-switch read fails with
// "No metadata for X was found" and the entire pipeline silently no-ops.
import { NotificationEmailLog } from './notifications/entities/notification-email-log.entity';
import { NotificationSetting } from './notifications/entities/notification-settings.entity';
import { NotificationSettingsAudit } from './notifications/entities/notification-settings-audit.entity';
// Wave 96 — same registration footgun as Wave 91. NotificationLineLog must
// be in the root `entities[]` list because forRoot uses an explicit array
// (no `autoLoadEntities: true`). Without this, every `queueLine` audit
// write fails with `EntityMetadataNotFoundError: No metadata for
// "NotificationLineLog" was found` and the LINE pipeline silently no-ops.
import { NotificationLineLog } from './notifications/entities/notification-line-log.entity';
// Wave 97 — quota-alert config table. Same registration footgun as W91/W96
// (forRoot uses an explicit `entities[]` list, no autoLoadEntities).
import { NotificationQuotaAlert } from './notifications/entities/notification-quota-alert.entity';
import { NotificationsAdminModule } from './notifications/admin/notifications-admin.module';
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
// SUPP_PRINT_DB_01 — supplement PDF document entities. Both must be
// registered at the root DataSource (entities[]) AND via forFeature in
// PdfModule — same registration footgun pattern documented for AI
// entities above. Without root registration TypeORM throws
// `EntityMetadataNotFoundError` at boot.
import { PdfSupplementDraftDocument } from './pdf/entities/pdf-supplement-draft-document.entity';
import { PdfSupplementApprovedDocument } from './pdf/entities/pdf-supplement-approved-document.entity';
// SUPP_BOOK_DB_01 — supplement user-uploaded Part 1 / Part 2 PDFs.
// Both must be registered at the root DataSource (entities[]) AND via
// forFeature in PdfModule — same registration footgun pattern called
// out for the supplement approved/draft docs above. Forgetting root
// registration triggers `EntityMetadataNotFoundError` at boot.
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
// SUPP-3 / BE-07 — SPG attachment module (new table mirrors PG / RPG split).
import { AttachmentSupplementProjectGroupsModule } from './attachment-supplement-project-groups/attachment-supplement-project-groups.module';
import { AttachmentSupplementProjectGroup } from './attachment-supplement-project-groups/entities/attachment-supplement-project-group.entity';
import { BookAssemblyModule } from './book-assembly/book-assembly.module';
import { BookAssemblyDraft } from './book-assembly/entities/book-assembly-draft.entity';
import { BookAssemblyVersion } from './book-assembly/entities/book-assembly-version.entity';
import { DeprecationAuditLog } from './book-assembly/entities/deprecation-audit-log.entity';
import { BookProjectLineage } from './book-assembly/entities/book-project-lineage.entity';
// SUPP_STANDALONE_DB_01 — standalone Supplement Assembly entities.
// Q3=B duplicate of BookAssembly shape in dedicated tables; zero shared
// mutable surface with BookAssembly. Root-DataSource registration is
// required even before BE_04 wires `SupplementAssemblyModule` because
// otherwise TypeORM throws `EntityMetadataNotFoundError` the first time
// any repository for one of these entities is requested (Wave 41
// post-mortem / TEMPLATE.md §8.1).
import { SupplementAssemblyDraft } from './supplement-assembly/entities/supplement-assembly-draft.entity';
import { SupplementAssemblyVersion } from './supplement-assembly/entities/supplement-assembly-version.entity';
import { SupplementAssemblyVersionProject } from './supplement-assembly/entities/supplement-assembly-version-project.entity';
// SUPP_STANDALONE_BE_04 — wires the standalone Supplement Assembly
// subsystem (Wave 3 of 6). Imported AFTER `BookAssemblyModule` for
// thematic locality; no cyclical dependency between the two (Q10=B
// standalone). `SupplementAssemblyService` consumes `PdfModule`,
// `BookLockModule`, and `OrphanCleanupModule` per §18.2.1.
import { SupplementAssemblyModule } from './supplement-assembly/supplement-assembly.module';
import { DevelopmentIssueModule } from './development-issue/development-issue.module';
import { DevelopmentIssue } from './development-issue/entities/development-issue.entity';
import { AdminDocumentAnalysisModule } from './admin-document-analysis/admin-document-analysis.module';
import { AiPreSubmitSnapshot } from './ai/entities/ai-pre-submit-snapshot.entity';
// Wave 40 N4 — staff reviewer AI run cache. Registered at the root
// DataSource so TypeORM knows about the entity's metadata. Forgetting
// this causes `EntityMetadataNotFoundError: No metadata for
// "AiStaffReviewRun" was found.` even though the feature module
// registers it via `TypeOrmModule.forFeature` — `forFeature` only
// provides the repository injection token, not the metadata itself.
import { AiStaffReviewRun } from './ai/entities/ai-staff-review-run.entity';
// Wave 44 DB-W44-01 — Executive AI Chat feature. Both entities must be
// registered at the root DataSource (entities[]) AND via forFeature in
// the feature module; forgetting the former triggers
// `EntityMetadataNotFoundError` at boot — same footgun as the Wave 40
// `AiStaffReviewRun` registration above. CLAUDE.md §17.3 — neither
// entity has a FK into project / plan / tracking tables.
import { AiExecutiveChatModule } from './ai-executive-chat/ai-executive-chat.module';
// Wave 44 DB-W44-02 — startup bootstrap hook that applies an
// allow-listed, idempotent DDL catalog after the DataSource is up.
// See `docs/tasks/wave44/DB-W44-02.md` and
// `docs/reports/WAVE44_RUNTIME_FAILURE_RCA.md` §5 (fix F3c).
import { BootstrapModule } from './bootstrap/bootstrap.module';
import { AiExecutiveConversation } from './ai-executive-chat/entities/ai-executive-conversation.entity';
import { AiExecutiveMessage } from './ai-executive-chat/entities/ai-executive-message.entity';
// PRIV-W44-01 — global LLM client abstraction (CLAUDE.md §17). Every
// AI-consuming module (ai, document-analysis, ai-executive-chat) picks
// up the injected `LLM_CLIENT` via this `@Global()` registration.
import { LlmClientModule } from './ai/llm/llm-client.module';
// Wave 86 W86-BE-LINE-WEBHOOK — LINE chatbot integration. The
// `LineUserBinding` entity must be registered at the root DataSource
// (entities[]) AND via `forFeature` in `LineModule` — the same
// footgun pattern called out for AiStaffReviewRun / AiExecutiveChat
// above. Without root registration, TypeORM throws
// `EntityMetadataNotFoundError` at boot.
import { LineModule } from './line/line.module';
import { LineUserBinding } from './line/entities/line-user-binding.entity';
// W97-API-BINDINGS — super-admin LINE binding registry audit table.
// Same root-DataSource registration footgun as the AI / LINE entities
// above: `forFeature` in `NotificationsLineModule` provides the repo
// injection token, but the metadata MUST also be listed here or
// TypeORM throws `EntityMetadataNotFoundError` at boot.
import { LineBindingAdminAction } from './notifications/line/entities/line-binding-admin-action.entity';
// Wave 106 BE-PR1 — user presence subsystem (REST + WS hardening + Redis
// tracker + cron sweeper). PresenceModule owns its own ioredis client
// (separate from Bull's connection pool) and exposes PresenceService for
// the WebsocketGateway. §4.1 / §17.2 — presence is advisory metadata only.
import { PresenceModule } from './presence/presence.module';
// Wave 107 DB-PR1 — System Usage Statistics persistence. Same root
// DataSource registration footgun as the AI / LINE entities above:
// `forFeature` in `SystemUsageModule` provides the repo injection
// tokens, but the metadata MUST also be listed in the root
// `entities[]` or TypeORM throws `EntityMetadataNotFoundError` at
// boot. CLAUDE.md §17.3 — neither entity has a FK into project /
// plan / tracking / users tables.
import { SystemUsageModule } from './system-usage/system-usage.module';
import { SystemUsageDailyRollup } from './system-usage/entities/system-usage-daily-rollup.entity';
import { StatsAccessLog } from './system-usage/entities/stats-access-log.entity';
// Wave 110 W110-BE-01 — orphan-cleanup auto-cascade module. Exports
// `OrphanCleanupService` consumed by DPR / Plan / Supplement softRemove
// + book-assembly + pdf finalize sites. CLAUDE.md §18 + workflow doc.
import { OrphanCleanupModule } from './orphan-cleanup/orphan-cleanup.module';
// SUPP_AGG_BE_01 — Unified Projects (PG + RPG + SPG) read-only HTTP
// surface. Imports `AggregationModule` to consume the Wave 54
// `UnifiedProjectAggregator` via DI token. Dependency direction is
// one-way; AggregationModule MUST NOT import UnifiedProjectsModule.
import { UnifiedProjectsModule } from './unified-projects/unified-projects.module';
// Wave 2 — Storage Layout Restructure (BE-PATH-SERVICE). `StorageModule`
// is now `@Global` so `StoragePathService` is injectable from any module
// without explicit import. Registered here in addition to the existing
// per-feature imports (e.g. `UsersModule`) — `@Global` modules registered
// twice are a no-op but the root registration is what enables global
// availability for downstream waves (BE-WRITERS, BE-READERS,
// BE-BOOTSTRAP, BE-MIGRATION).
import { StorageModule } from './storage/storage.module';


@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Single source of truth — `.env.${NODE_ENV}` only. The legacy
      // `.env` fallback was removed (2026-05-17) after verifying
      // zero unique vars existed in `.env` that weren't already in
      // `.env.development` + `.env.production`. NODE_ENV MUST be set
      // by the start script (see package.json `start:dev` / `start:prod`).
      envFilePath: [`.env.${process.env.NODE_ENV}`],
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
        AiPreSubmitSnapshot,
        AiStaffReviewRun,
        AiExecutiveConversation,
        AiExecutiveMessage,
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
        // SUPP_PRINT_DB_01 — supplement draft + approved PDF
        // document tables. Q4=B defers out-authority variant.
        PdfSupplementDraftDocument,
        PdfSupplementApprovedDocument,
        RevisionType,
        DevelopmentPlanRevision,
        RevisedProjectGroup,
        DevelopmentPlanSupplement,
        SupplementProjectGroup,
        PlanPhase,
        AttachmentProjectGroup,
        AttachmentRevisedProjectGroup,
        AttachmentSupplementProjectGroup,
        BookAssemblyDraft,
        BookAssemblyVersion,
        DeprecationAuditLog,
        BookProjectLineage,
        // SUPP_STANDALONE_DB_01 — owned by `SupplementAssemblyModule`
        // (created by BE_04); root registration here is required for
        // metadata resolution. §15 / §18.2.1 — no FK into book_assembly_*
        // tables.
        SupplementAssemblyDraft,
        SupplementAssemblyVersion,
        SupplementAssemblyVersionProject,
        DevelopmentIssue,
        LineUserBinding,
        // Wave 91 — Wave 21/22 notification entities (see import note).
        NotificationEmailLog,
        NotificationSetting,
        NotificationSettingsAudit,
        // Wave 96 — LINE notification audit row (same footgun rationale).
        NotificationLineLog,
        // Wave 97 — quota-alert config rows (W97-MIGRATION shipped table).
        NotificationQuotaAlert,
        // W97-API-BINDINGS — admin-action audit table (W97-MIGRATION
        // shipped table). Owned by `NotificationsLineModule` via
        // `TypeOrmModule.forFeature([...])`; root registration here
        // unblocks the repo injection in `LineBindingsController`.
        LineBindingAdminAction,
        // Wave 107 DB-PR1 — System Usage Statistics. Owned by
        // `SystemUsageModule` via `forFeature`; root registration here
        // is required so TypeORM resolves metadata at boot (no FK to
        // project / plan / tracking / users tables — §17.3).
        SystemUsageDailyRollup,
        StatsAccessLog,
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
    NotificationsEmailModule,
    // Wave 96 — LINE notification pipeline (mirror of email module). Must
    // be imported AFTER NotificationsEmailModule because it consumes the
    // re-exported NotificationSettingsService + RecipientResolverService.
    NotificationsLineModule,
    // Wave 97 — admin quota + alert CRUD + cron worker. Imported AFTER
    // both NotificationsEmailModule and NotificationsLineModule so the
    // exported stats services resolve cleanly.
    NotificationsAdminModule,
    // W108 BE-PR1 — user notification inbox API. Imported AFTER
    UserNotificationsModule,
    // Wave 106 BE-PR1 — must be imported BEFORE WebsocketModule because
    // WebsocketModule's gateway constructor depends on PresenceService.
    PresenceModule,
    // Wave 107 DB-PR1 — entity-only module (no controllers / services
    // until BE-PR1 / BE-PR2). Order is irrelevant; placed near
    // PresenceModule for thematic locality with W106 telemetry work.
    SystemUsageModule,
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
    AttachmentSupplementProjectGroupsModule,
    AdminDocumentAnalysisModule,
    BookAssemblyModule,
    // Wave 110 W110-BE-01 — must be imported BEFORE the modules that
    // wire its service into their softRemove / finalize sites. Order
    // here is otherwise irrelevant because the service has no
    // module-level cyclical dependency (it only depends on
    // LineageLockModule + TypeORM repos).
    OrphanCleanupModule,
    // SUPP_STANDALONE_BE_04 — standalone Supplement Assembly subsystem.
    // Imported AFTER `OrphanCleanupModule` because
    // `SupplementAssemblyService.merge()` consumes `OrphanCleanupService`
    // as the §18.2.1 SUPPLEMENT finalize trigger surface (cascade
    // BEFORE `isBooked = true`). Imported AFTER `PdfModule` (declared
    // earlier in this array) because the service injects
    // `SupplementPdfService` to generate Part 3.
    SupplementAssemblyModule,
    DevelopmentIssueModule,
    AiExecutiveChatModule,
    // SUPP_AGG_BE_01 — Unified Projects HTTP surface. Imported AFTER
    // `AiExecutiveChatModule` so the `AggregationModule` re-export
    // chain (UNIFIED_PROJECT_AGGREGATOR token) is fully resolved.
    UnifiedProjectsModule,
    // PRIV-W44-01 — global LLM client (must import before any AI
    // module that injects `LLM_CLIENT`).
    LlmClientModule,
    // W86-BE-LINE-WEBHOOK — LINE chatbot module. Public webhook is
    // signature-gated via `LineSignatureGuard`; the module's own
    // `ThrottlerModule.forRoot([...])` applies a 100/60s rate limit
    // keyed on IP. Imported AFTER `LlmClientModule` so any future
    // injection of `LLM_CLIENT` into the LINE AI bridge resolves
    // against a fully-registered global provider.
    LineModule,
    // DB-W44-02 — bootstrap hook for corrective DDL (registered last
    // so every other module's TypeORM registration completes first,
    // giving the allow-listed ALTERs a settled DataSource).
    BootstrapModule,
    // Wave 2 BE-PATH-SERVICE — `@Global` module exposing
    // `StoragePathService` for every downstream PDF writer / reader.
    // Order is irrelevant because the service has no module-level
    // dependency (only ConfigService, registered globally above).
    StorageModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
