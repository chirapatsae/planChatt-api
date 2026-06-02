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
import { DivisionsModule } from './divisions/divisions.module';
import { Division } from './divisions/entities/division.entity';
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
// Wave Equipment Revision Management — attachment support for RELPG
// (clone of the RPG attachment module, no AI analysis).
import { AttachmentRevisedEquipmentProjectGroupsModule } from './attachment-revised-equipment-project-groups/attachment-revised-equipment-project-groups.module';
import { AttachmentRevisedEquipmentProjectGroup } from './attachment-revised-equipment-project-groups/entities/attachment-revised-equipment-project-group.entity';
// SUPP-3 / BE-07 — SPG attachment module (new table mirrors PG / RPG split).
import { AttachmentSupplementProjectGroupsModule } from './attachment-supplement-project-groups/attachment-supplement-project-groups.module';
import { AttachmentSupplementProjectGroup } from './attachment-supplement-project-groups/entities/attachment-supplement-project-group.entity';
import { BookAssemblyModule } from './book-assembly/book-assembly.module';
// Public Archive — anonymous read access to assembled (COMPLETED)
// development plan books. Anonymous citizens can browse + download via
// /v1/public/plans/* routes. See `public-archive/public-archive.module.ts`
// for the security model (no PII, COMPLETED-only versions).
import { PublicArchiveModule } from './public-archive/public-archive.module';
// Wave engagement-counters BE-01 — anonymous like / view / download
// surface for the public archive. Entities (engagement_likes,
// engagement_view_events, engagement_download_events) carry UUID
// `target_id` + discriminator WITHOUT FK per CLAUDE.md §17.3 — the
// audit log MUST survive §14.6 staff-led rollback and §18 orphan
// cleanup without ever being touched. IP / UA are NEVER persisted.
import { PublicEngagementModule } from './public-engagement/public-engagement.module';
import { EngagementLike } from './public-engagement/entities/engagement-like.entity';
import { EngagementViewEvent } from './public-engagement/entities/engagement-view-event.entity';
import { EngagementDownloadEvent } from './public-engagement/entities/engagement-download-event.entity';
// CLEANUP wave (2026-05-26) — the legacy `BookAssemblyDraft`,
// `BookAssemblyVersion`, `BookProjectLineage`, and `DeprecationAuditLog`
// entities + their tables have all been deleted alongside the legacy
// `BookAssemblyService` / `BookAssemblyController`. `src/book-assembly/`
// now exposes only `BookAssemblyFileService` per the Q3=B file-service
// exemption (CLAUDE.md §20.10.3); zero entities remain to register.
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
// Wave A1 / DB-01 — standalone MAIN_PLAN Assembly entities. Same Q3=B
// duplicate / root-registration footgun as SUPP_STANDALONE_DB_01 above:
// `forFeature` in `MainAssemblyModule` provides the repo injection
// token, but the metadata MUST also be listed in the root `entities[]`
// list below or TypeORM throws `EntityMetadataNotFoundError` at boot.
// BE-01 (cloned `MainAssemblyService`) is deferred — DB-01 only ships
// schema + module skeleton.
import { MainAssemblyDraft } from './main-assembly/entities/main-assembly-draft.entity';
import { MainAssemblyVersion } from './main-assembly/entities/main-assembly-version.entity';
import { MainAssemblyVersionProject } from './main-assembly/entities/main-assembly-version-project.entity';
import { MainProjectLineage } from './main-assembly/entities/main-project-lineage.entity';
import { MainAssemblyModule } from './main-assembly/main-assembly.module';
// Wave A2 / DB-01 + BE-01 — standalone EDIT_REVISION Assembly entities.
// Same Q3=B duplicate / root-registration footgun as the MAIN entities
// above: `forFeature` in `EditAssemblyModule` provides the repo
// injection token, but the metadata MUST also be listed in the root
// `entities[]` list below or TypeORM throws
// `EntityMetadataNotFoundError` at boot. BE-01 (cloned
// `EditAssemblyService`) ships alongside this registration; the legacy
// `BookAssemblyService` continues to serve EDIT_REVISION traffic via
// `book_assembly_*` tables until FE-01 atomically switches FE clients.
import { EditAssemblyDraft } from './edit-assembly/entities/edit-assembly-draft.entity';
import { EditAssemblyVersion } from './edit-assembly/entities/edit-assembly-version.entity';
import { EditAssemblyVersionProject } from './edit-assembly/entities/edit-assembly-version-project.entity';
import { EditProjectLineage } from './edit-assembly/entities/edit-project-lineage.entity';
import { EditAssemblyModule } from './edit-assembly/edit-assembly.module';
// Wave A3 / DB-01 + BE-01 — standalone CHANGE_REVISION Assembly entities.
// Same Q3=B duplicate / root-registration footgun as the MAIN and EDIT
// entities above: `forFeature` in `ChangeAssemblyModule` provides the
// repo injection token, but the metadata MUST also be listed in the
// root `entities[]` list below or TypeORM throws
// `EntityMetadataNotFoundError` at boot. BE-01 (cloned
// `EditAssemblyService` adapted for CHANGE_REVISION) ships alongside
// this registration; the legacy `BookAssemblyService` continues to
// serve CHANGE_REVISION traffic via `book_assembly_*` tables until
// FE-01 atomically switches FE clients.
import { ChangeAssemblyDraft } from './change-assembly/entities/change-assembly-draft.entity';
import { ChangeAssemblyVersion } from './change-assembly/entities/change-assembly-version.entity';
import { ChangeAssemblyVersionProject } from './change-assembly/entities/change-assembly-version-project.entity';
import { ChangeProjectLineage } from './change-assembly/entities/change-project-lineage.entity';
import { ChangeAssemblyModule } from './change-assembly/change-assembly.module';
// wave-supplement-convergence-milestone-5 / DB-01 — segregated SPG
// lineage table (CTO M4 decision Option B). Same root-registration
// footgun as the three entities above; forgetting this line triggers
// `EntityMetadataNotFoundError` at boot when BE-01 first requests the
// repository.
import { SupplementProjectLineage } from './supplement-assembly/entities/supplement-project-lineage.entity';
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
// Strategic Graph BE-01 — four master vocabulary modules
// (`NationalStrategy`, `Sdg`, `Milestone`, `ProvinceStrategy`). Each
// entity MUST be listed in BOTH `TypeOrmModule.forRoot({ entities })`
// AND `imports: [...]` below or the boot fails with
// `EntityMetadataNotFoundError` (Wave 41 footgun; umbrella §8.1).
// Routes are namespaced under `/v1/strategic-graph/...` (user-locked
// 2026-05-18). Reads are open to any authenticated user; writes are
// admin + super-admin only (gated inside each service via
// `assertAdminOrSuperAdmin`, mirroring `DevelopmentIssueService`).
import { NationalStrategyModule } from './national-strategy/national-strategy.module';
import { NationalStrategy } from './national-strategy/entities/national-strategy.entity';
import { SdgModule } from './sdg/sdg.module';
import { Sdg } from './sdg/entities/sdg.entity';
import { MilestoneModule } from './milestone/milestone.module';
import { Milestone } from './milestone/entities/milestone.entity';
import { ProvinceStrategyModule } from './province-strategy/province-strategy.module';
import { ProvinceStrategy } from './province-strategy/entities/province-strategy.entity';
// Strategic Graph BE-03 — eight junction entities + consolidating
// module (DB-02 inter-master + DB-03 plan-mapping tables). Same
// Wave 41 footgun as BE-01 above: every `@Entity` must be listed in
// BOTH `TypeOrmModule.forRoot({ entities: [...] })` AND `imports: [...]`
// or boot fails with `EntityMetadataNotFoundError`. Routes are mounted
// by downstream Wave 3 (BE-04/05/06) under `/v1/strategic-graph/...`;
// this wave is entity + module wiring only.
import { StrategicMappingModule } from './strategic-mapping/strategic-mapping.module';
import { ProjectAlignmentMappingModule } from './project-alignment-mapping/project-alignment-mapping.module';
import { ProjectAlignmentMapping } from './project-alignment-mapping/entities/project-alignment-mapping.entity';
// Wave multi-national-strategy-per-alignment / DB-01 — 3 uniform
// junctions for multi-value secondaries on NS / SDG / PS. Same Wave 41
// dual-reg rule: every `@Entity` must be listed BOTH in the module's
// `forFeature(...)` AND here in `forRoot({ entities: [...] })`, or
// TypeORM boot dies with `EntityMetadataNotFoundError`.
import { ProjectAlignmentNationalStrategy } from './project-alignment-mapping/entities/project-alignment-national-strategy.entity';
import { ProjectAlignmentSdg } from './project-alignment-mapping/entities/project-alignment-sdg.entity';
import { ProjectAlignmentProvinceStrategy } from './project-alignment-mapping/entities/project-alignment-province-strategy.entity';
// CHAIN-CLEANUP 2026-05-18 — schema narrowed to strict NS→MS→SDG↔PS chain.
// Dropped: SdgNationalStrategy, ProvinceStrategyNationalStrategy,
// MilestoneProvinceStrategy. Row backup at
// backups/strategic_cross_links_2026-05-18.sql.
import { MilestoneSdg } from './strategic-mapping/entities/milestone-sdg.entity';
import { ProvinceStrategySdg } from './strategic-mapping/entities/province-strategy-sdg.entity';
// CLEANUP 2026-05-18: removed PlanSdg / PlanNationalStrategy /
// PlanMilestone / PlanProvinceStrategy — orphan plan-mapping
// junctions (4 tables, all 0 rows, no UI consumer).
import { NationalStrategyMilestone } from './strategic-mapping/entities/national-strategy-milestone.entity';
// Wave wave-backup-login-thaid-fallback / DB-01 — ThaiD-fallback backup
// login subsystem. Five entities live under `backend/src/backup-login/`
// and MUST all be listed in BOTH the root `entities[]` list (TypeORM
// metadata resolution) AND in `BackupLoginModule` via
// `TypeOrmModule.forFeature([...])` (repo injection token). BE-01 will
// create the module; DB-01 only ships entities + root registration.
// The append-only triggers on `backup_login_audit_logs` are NOT created
// by `synchronize:true` — see
// `backend/src/backup-login/sql/backup-login-audit-log.triggers.sql`
// for the psql-runnable script applied post-restart.
import { BackupCredential } from './backup-login/entities/backup-credential.entity';
import { TotpEnrollment } from './backup-login/entities/totp-enrollment.entity';
import { PasswordHistory } from './backup-login/entities/password-history.entity';
import { BackupLoginAuditLog } from './backup-login/entities/backup-login-audit-log.entity';
import { BackupLoginKillSwitchConfig } from './backup-login/entities/backup-login-kill-switch-config.entity';
// Wave wave-backup-login-thaid-fallback / BE-01 — backup-login module
// wiring (services + controller + crons + boot hook). Imported AFTER
// `AuthModule` so the JWT secret/strategy is already registered.
import { BackupLoginModule } from './backup-login/backup-login.module';
// Wave Equipment ผ.03, Phase 1 — DB-01. Two reference tables backing
// the future cascading-filter endpoint "(tacticId, planId) → valid
// equipment categories". Same Wave 41 dual-registration footgun as
// every other entity above: `forFeature` in `EquipmentCategoryModule`
// provides the repo injection token, but the metadata MUST also be
// listed in the root `entities[]` list below or TypeORM throws
// `EntityMetadataNotFoundError` at boot. DB-01 ships entities +
// module skeleton only; service / controller are deferred to BE-01.
import { EquipmentCategory } from './equipment-category/entities/equipment-category.entity';
import { EquipmentCategoryScope } from './equipment-category/entities/equipment-category-scope.entity';
import { EquipmentCategoryModule } from './equipment-category/equipment-category.module';
// Wave Equipment ผ.03, Phase 2 — DB-02 (2026-05-28). Equipment project
// entity (sibling of PG / RPG / SPG) + tracking_status fourth FK
// (`equipment_project_group_id`). Same Wave 41 dual-registration
// footgun as every other entity above: `forFeature` in
// `EquipmentProjectGroupModule` provides the repo injection token, but
// the metadata MUST also be listed in the root `entities[]` list below
// or TypeORM throws `EntityMetadataNotFoundError` at boot. Budget
// polymorphism extension on the existing `Budget` entity does NOT
// require a new root registration. Service/controller deferred to
// BE-04.
import { EquipmentProjectGroup } from './equipment-project-group/entities/equipment-project-group.entity';
import { EquipmentProjectGroupModule } from './equipment-project-group/equipment-project-group.module';
// Wave Equipment Revision Management — DB-01 (Phase 3). RELPG is the
// equipment (ผ.03) analog of RevisedProjectGroup: a lineage fork from an
// approved EquipmentProjectGroup into a DevelopmentPlanRevision. Same
// Wave 41 footgun as every other entity — `forFeature` in
// `RevisedEquipmentProjectGroupModule` provides the repo token, but the
// metadata MUST also be in the root `entities[]` list below. Budget +
// tracking_status polymorphic extension is on the existing entities and
// needs no extra root registration. Service/controller deferred to BE-01.
import { RevisedEquipmentProjectGroup } from './revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { RevisedEquipmentProjectGroupModule } from './revised-equipment-project-group/revised-equipment-project-group.module';
// Wave Unified Equipment Tab — BE-01. Read-only unified equipment
// projection (EPG + RELPG, §14.2 HEAD-of-lineage REPLACE semantic) for
// the `/project?tab=equipment` surface. No new @Entity — reads the
// already-registered EquipmentProjectGroup / RevisedEquipmentProjectGroup
// / WorkHistory roots.
import { UnifiedEquipmentModule } from './unified-equipment/unified-equipment.module';


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
        Division,
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
        // CLEANUP wave (2026-05-26) — every legacy `book_assembly_*`
        // entity has been deleted alongside `DeprecationAuditLog`
        // (0 live writers, 0 historical rows). `src/book-assembly/` now
        // contributes ZERO entities; only `BookAssemblyFileService`
        // remains per CLAUDE.md §20.10.3 Q3=B file-service exemption.
        // SUPP_STANDALONE_DB_01 — owned by `SupplementAssemblyModule`
        // (created by BE_04); root registration here is required for
        // metadata resolution. §15 / §18.2.1 — no FK into book_assembly_*
        // tables.
        SupplementAssemblyDraft,
        SupplementAssemblyVersion,
        SupplementAssemblyVersionProject,
        // wave-supplement-convergence-milestone-5 / DB-01 — see import note.
        SupplementProjectLineage,
        // Wave A1 / DB-01 — standalone MAIN_PLAN Assembly entities.
        // Owned by `MainAssemblyModule` (skeleton only — BE-01 lands
        // service + controller later). Root registration here is
        // required for metadata resolution. NO FK into `book_assembly_*`
        // tables (Q3=B standalone).
        MainAssemblyDraft,
        MainAssemblyVersion,
        MainAssemblyVersionProject,
        MainProjectLineage,
        // Wave A2 / DB-01 + BE-01 — standalone EDIT_REVISION Assembly
        // entities. Owned by `EditAssemblyModule`. Root registration
        // here is required for metadata resolution. NO FK into
        // `book_assembly_*` / `main_assembly_*` tables (Q3=B standalone).
        EditAssemblyDraft,
        EditAssemblyVersion,
        EditAssemblyVersionProject,
        EditProjectLineage,
        // Wave A3 / DB-01 + BE-01 — standalone CHANGE_REVISION Assembly
        // entities. Owned by `ChangeAssemblyModule`. Root registration
        // here is required for metadata resolution. NO FK into
        // `book_assembly_*` / `main_assembly_*` / `edit_assembly_*`
        // tables (Q3=B standalone).
        ChangeAssemblyDraft,
        ChangeAssemblyVersion,
        ChangeAssemblyVersionProject,
        ChangeProjectLineage,
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
        // Strategic Graph BE-01 — four master vocabulary entities.
        // Owned by their feature modules via `forFeature`; root
        // registration here is mandatory or TypeORM throws
        // `EntityMetadataNotFoundError` (Wave 41 footgun; umbrella §8.1).
        NationalStrategy,
        Sdg,
        Milestone,
        ProvinceStrategy,
        // Strategic Graph — chain junctions (NS→MS→SDG↔PS). Owned by
        // `StrategicMappingModule` via `forFeature`; root registration
        // here is mandatory or TypeORM throws
        // `EntityMetadataNotFoundError` (Wave 41 footgun).
        NationalStrategyMilestone,
        MilestoneSdg,
        ProvinceStrategySdg,
        // Project alignment triple-keyed bridge. Owned by
        // `ProjectAlignmentMappingModule`; same Wave 41 dual-reg rule.
        ProjectAlignmentMapping,
        // Wave multi-national-strategy-per-alignment / DB-01 — 3 uniform
        // junctions for multi-value secondaries on NS / SDG / PS.
        // Owned by `ProjectAlignmentMappingModule`; same dual-reg rule.
        ProjectAlignmentNationalStrategy,
        ProjectAlignmentSdg,
        ProjectAlignmentProvinceStrategy,
        // Wave engagement-counters BE-01 — anonymous engagement audit
        // tables. NO FK to project / plan / tracking tables (§17.3).
        // Owned by `PublicEngagementModule` via `forFeature`; root
        // registration here is required for metadata resolution
        // (Wave 41 footgun; umbrella §8.1).
        EngagementLike,
        EngagementViewEvent,
        EngagementDownloadEvent,
        // Wave wave-backup-login-thaid-fallback / DB-01 — five entities
        // backing the ThaiD-fallback backup login (BackupCredential,
        // TotpEnrollment, PasswordHistory, BackupLoginAuditLog,
        // BackupLoginKillSwitchConfig). To be owned by `BackupLoginModule`
        // via `forFeature` once BE-01 lands; root registration here is
        // mandatory or TypeORM throws `EntityMetadataNotFoundError` at
        // boot (Wave 41 footgun; CLAUDE.md §8.1).
        BackupCredential,
        TotpEnrollment,
        PasswordHistory,
        BackupLoginAuditLog,
        BackupLoginKillSwitchConfig,
        // Wave Equipment ผ.03, Phase 1 — DB-01. Reference-data tables;
        // no FK into project / plan / tracking / users (CLAUDE.md §10).
        // Owned by `EquipmentCategoryModule` via `forFeature`; root
        // registration here is required for metadata resolution (Wave
        // 41 footgun; TEMPLATE.md §8.1).
        EquipmentCategory,
        EquipmentCategoryScope,
        // Wave Equipment ผ.03, Phase 2 — DB-02 (see import note).
        // Sibling of ProjectGroup / RevisedProjectGroup /
        // SupplementProjectGroup; goes through the full §12 workflow
        // via the new `equipment_project_group_id` FK on tracking_status.
        EquipmentProjectGroup,
        // Wave Equipment Revision Management — DB-01 (Phase 3). RELPG —
        // equipment analog of RevisedProjectGroup. §12 audit via the new
        // `revised_equipment_project_group_id` FK on tracking_status (5th).
        RevisedEquipmentProjectGroup,
        // Wave Equipment Revision Management — attachment support for RELPG
        // (clone of the RPG attachment table; FK → revised_equipment_project_groups).
        AttachmentRevisedEquipmentProjectGroup,
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
    DivisionsModule,
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
    AttachmentRevisedEquipmentProjectGroupsModule,
    AttachmentSupplementProjectGroupsModule,
    AdminDocumentAnalysisModule,
    BookAssemblyModule,
    PublicArchiveModule,
    // Wave engagement-counters BE-01 — must be imported AFTER
    // PublicArchiveModule because the engagement service consumes the
    // shared `getPublishedPlanIdsPublic()` predicate (forwardRef on
    // both sides handles the bidirectional dependency).
    PublicEngagementModule,
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
    // Wave A1 / DB-01 — standalone MAIN_PLAN Assembly subsystem (Wave
    // A1 of 3 in OPTION-A-FULL-SPLIT). Skeleton-only module — BE-01
    // (cloned `MainAssemblyService` + controller) is deferred. Imported
    // here so `forFeature` repo tokens are available the moment BE-01
    // lands. Order is irrelevant; no cyclical dependency.
    MainAssemblyModule,
    // Wave A2 / BE-01 — standalone EDIT_REVISION Assembly subsystem
    // (Wave A2 of 3 in OPTION-A-FULL-SPLIT). Imported AFTER
    // `OrphanCleanupModule` (`merge()` cascade fires inside the
    // finalize transaction) and AFTER `PdfModule` (Part 3 generation
    // calls `PdfService.generateRevisionApprovedReportWithPageTracking`).
    // Order vs `MainAssemblyModule` is irrelevant; no cyclical
    // dependency.
    EditAssemblyModule,
    // Wave A3 / BE-01 — standalone CHANGE_REVISION Assembly subsystem
    // (Wave A3 of 3 in OPTION-A-FULL-SPLIT). Mirror of `EditAssemblyModule`
    // because CHANGE is also a `DevelopmentPlanRevision` rooted book.
    // Imported AFTER `OrphanCleanupModule` (`merge()` cascade fires
    // inside the finalize transaction) and AFTER `PdfModule` (Part 3
    // generation calls
    // `PdfService.generateRevisionApprovedReportWithPageTracking` — the
    // same revision-style PDF entry point that EDIT uses). Order vs
    // `EditAssemblyModule` is irrelevant; no cyclical dependency.
    ChangeAssemblyModule,
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
    // Strategic Graph BE-01 — four master vocabulary modules. Order
    // irrelevant; no cross-module dependencies. Routes namespaced
    // under `/v1/strategic-graph/...`. DB-02 / DB-03 will add the
    // junction tables that reference these masters via FK.
    NationalStrategyModule,
    SdgModule,
    MilestoneModule,
    ProvinceStrategyModule,
    // Strategic Graph BE-03 — junction entities module. Order is
    // irrelevant; no cross-module runtime dependency. Wave 3
    // (BE-04/05/06) will mount the service + controller routes.
    StrategicMappingModule,
    ProjectAlignmentMappingModule,
    // Wave wave-backup-login-thaid-fallback / BE-01 — backup-login
    // subsystem. Imported AFTER `AuthModule` so JWT registration is
    // already in place; the module owns its own JwtModule.register
    // for sign + verify of mfaChallengeToken / final session JWT.
    BackupLoginModule,
    // Wave Equipment ผ.03, Phase 1 — DB-01. Module skeleton only
    // (service + controller deferred to BE-01). Order is irrelevant;
    // no cyclical dependency. `forFeature` registration here unblocks
    // future BE-01 repository injection.
    EquipmentCategoryModule,
    // Wave Equipment ผ.03, Phase 2 — DB-02 (see import note above).
    // Entity-only skeleton; controller/service deferred to BE-04. Order
    // irrelevant; no cyclical dependency.
    EquipmentProjectGroupModule,
    // Wave Equipment Revision Management — DB-01 (Phase 3). Entity-only
    // skeleton; service/controller deferred to BE-01. Order irrelevant.
    RevisedEquipmentProjectGroupModule,
    // Wave Unified Equipment Tab — BE-01. Read-only unified equipment
    // (EPG + RELPG) projection for `/project?tab=equipment`.
    UnifiedEquipmentModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
