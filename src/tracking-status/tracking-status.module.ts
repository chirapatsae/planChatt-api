import { Module } from '@nestjs/common';
import { TrackingStatusService } from './tracking-status.service';
import { TrackingStatusController } from './tracking-status.controller';
import { TrackingStatus } from './entities/tracking-status.entity';
import { User } from 'src/users/entities/user.entity';
import { Status } from 'src/status/entities/status.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Comment } from 'src/comments/entities/comment.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
// SUPP-1 / BE-02 — register SupplementProjectGroup so the tracking-status
// service can resolve and mutate SPG rows (workflow transitions + rollback
// hard-delete) inside the same transaction as the TrackingStatus write.
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
// Wave Equipment ผ.03 Phase 2 — BE-04b (2026-05-28). Register
// EquipmentProjectGroup so workflow transitions (Ready → Pending →
// Verified → … → Approved + Pull_Back + Returned_For_Revision + Rejected)
// and staff-led rollback can resolve and mutate equipment rows inside
// the same transaction as the TrackingStatus write. Mirrors PG (NOT
// RPG/SPG) for amphoe-based responsibility + main-plan scope binding.
import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';

import { AnnouncementsModule } from 'src/announcements/announcements.module';
import { WorkHistoryAmphoeResponsibility } from 'src/work-history-amphoe-responsibility/entities/work-history-amphoe-responsibility.entity';
import { WorkHistoryGovernmentAgencyResponsibility } from 'src/work-history-government-agency-responsibility/entities/work-history-government-agency-responsibility.entity';
import { LineageLockModule } from 'src/common/lineage-lock/lineage-lock.module';
import { NotificationsEmailModule } from 'src/notifications/email/notifications-email.module';
import { NotificationsLineModule } from 'src/notifications/line/notifications-line.module';
// W105 BE-PR2 — digest dispatcher consumed by TrackingStatusService.bulkSubmit
// to collapse N per-project notifications into ONE digest job per
// (recipientUserId, eventType) group. Registered as a provider here so it
// can be constructor-injected; depends on NotificationsEmail/LineModule
// (already imported above) and the local Status repository (already in
// TypeOrmModule.forFeature below).
import { DigestDispatcherService } from 'src/notifications/digest/digest-dispatcher.service';
import { UsersModule } from 'src/users/users.module';
// SUPP-IA-03 (BE-β, 2026-05-12) — `PreSubmitSnapshotService` is
// consumed by the SPG branch of `TrackingStatusService` to write the
// §17.4 `no-ai-baseline` row at the owner Ready → Pending transition
// (relocated from `SupplementProjectGroupService.create`). The
// resolver is used to derive `classification.reportFormat` for the
// snapshot DTO.
import { AiModule } from 'src/ai/ai.module';
import { ProjectClassificationModule } from 'src/common/project-classification/project-classification.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TrackingStatus,
      User,
      Status,
      WorkHistory,
      Comment,
      ProjectGroup,
      RevisedProjectGroup,
      SupplementProjectGroup,
      DevelopmentPlanSupplement,
      EquipmentProjectGroup,
      WorkHistoryAmphoeResponsibility,
      WorkHistoryGovernmentAgencyResponsibility,
    ]),
    AnnouncementsModule,
    LineageLockModule,
    NotificationsEmailModule,
    // W96-TRIGGER-WIRING — independent LINE fanout (Q9). Imported here so
    // TrackingStatusService can inject NotificationsLineService alongside
    // NotificationsEmailService.
    NotificationsLineModule,
    // W100 PR3 — needed by TrackingStatusService.maskActorUsersOnTracking
    // to call `usersService.decryptUserPii(user)` before masking actor email.
    // §17.11: masking is applied uniformly regardless of role; no reveal here.
    UsersModule,
    // SUPP-IA-03 (BE-β) — `AiModule` exports `PreSubmitSnapshotService`;
    // `ProjectClassificationModule` exports `BookFormatResolver`.
    AiModule,
    ProjectClassificationModule,
  ],
  controllers: [TrackingStatusController],
  providers: [TrackingStatusService, DigestDispatcherService],
})
export class TrackingStatusModule {}
