import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from 'src/users/entities/user.entity';
import { LineUserBinding } from 'src/line/entities/line-user-binding.entity';
import { LineModule } from 'src/line/line.module';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

import { NotificationLineLog } from '../entities/notification-line-log.entity';
import { NotificationsEmailModule } from '../email/notifications-email.module';

import {
  NOTIFICATIONS_LINE_QUEUE,
  NotificationsLineService,
} from './notifications-line.service';
import { LineNotificationProcessor } from './line-notification.processor';
import { FlexTemplateRendererService } from './flex-template-renderer.service';
import { DigestFlexBuilderService } from './digest-flex-builder.service';
import { NotificationsLineController } from './notifications-line.controller';
// Wave 97 — LINE-side aggregation parity with EmailStatsService for the
// admin quota dashboard and the alert worker.
import { LineStatsService } from './line-stats.service';
// W97-API-BINDINGS — super-admin LINE binding registry endpoints
// (list + reveal). This module OWNS the `LineBindingAdminAction` entity
// registration; W97-API-FORCE-UNLINK consumes it via the same forFeature
// registration in this module.
import { LineBindingsController } from './line-bindings.controller';
import { LineBindingAdminAction } from './entities/line-binding-admin-action.entity';

/**
 * Wave 96 — LINE notification module (mirror of `NotificationsEmailModule`).
 *
 * Responsibilities:
 *   - Register the Bull queue `notifications-line` (DISTINCT from
 *     `notifications-email` so consumer pools do not mix and one channel's
 *     congestion does not stall the other).
 *   - Register the audit-log entity (`NotificationLineLog`) for repo
 *     injection.
 *   - Re-register `User` + `LineUserBinding` for the dispatch service's
 *     2nd-pass preference + active-binding re-checks.
 *   - Import `LineModule` for the chokepoint `LineMessagingService` (which
 *     owns the W90 sandbox guard).
 *   - Import `NotificationsEmailModule` to reuse:
 *       * `NotificationSettingsService` for the kill-switch (now exposing
 *         `isLineEnabled()` alongside `isEmailEnabled()`).
 *       * `RecipientResolverService.enrichWithLineBindings(...)` for the
 *         1st-pass resolution. The resolver is co-located with the email
 *         module today; moving it to a shared sibling module is deferred
 *         (additive — unblocks W96 without disturbing email DI).
 *
 * §17.3 audit separation — `NotificationLineLog` has NO FK into project
 * tables; rollback hard-deletes (§14.6) cannot cascade in.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: NOTIFICATIONS_LINE_QUEUE }),
    TypeOrmModule.forFeature([
      User,
      LineUserBinding,
      NotificationLineLog,
      // W97-API-BINDINGS — admin-action audit table. Repository-injected
      // by `LineBindingsController` for the reveal write and consumed by
      // W97-API-FORCE-UNLINK for force-unlink writes.
      LineBindingAdminAction,
      // W97-API-BINDINGS — actor's current WorkHistory id is captured on
      // the audit row (CLAUDE.md §4 ownership-via-WorkHistory pattern).
      WorkHistory,
    ]),
    // LineMessagingService chokepoint — exports come from LineModule.
    LineModule,
    // Reuse kill-switch settings service + recipient resolver.
    NotificationsEmailModule,
  ],
  controllers: [NotificationsLineController, LineBindingsController],
  providers: [
    NotificationsLineService,
    LineNotificationProcessor,
    FlexTemplateRendererService,
    // W105 BE-PR2 — digest carousel builder. BE-PR3 created the class but
    // did not register it; wired here now that the dispatcher needs it.
    DigestFlexBuilderService,
    // Wave 97 — read-only aggregation service for admin quota endpoints.
    LineStatsService,
  ],
  exports: [
    NotificationsLineService,
    // W105 BE-PR2 — exported so DigestDispatcherService can be assembled
    // alongside the email + line dispatch services in TrackingStatusModule.
    DigestFlexBuilderService,
    // Wave 97 — exported so NotificationsAdminModule can resolve it.
    LineStatsService,
  ],
})
export class NotificationsLineModule {}
