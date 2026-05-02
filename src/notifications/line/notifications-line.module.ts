import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from 'src/users/entities/user.entity';
import { LineUserBinding } from 'src/line/entities/line-user-binding.entity';
import { LineModule } from 'src/line/line.module';

import { NotificationLineLog } from '../entities/notification-line-log.entity';
import { NotificationsEmailModule } from '../email/notifications-email.module';

import {
  NOTIFICATIONS_LINE_QUEUE,
  NotificationsLineService,
} from './notifications-line.service';
import { LineNotificationProcessor } from './line-notification.processor';
import { FlexTemplateRendererService } from './flex-template-renderer.service';
import { NotificationsLineController } from './notifications-line.controller';

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
    ]),
    // LineMessagingService chokepoint — exports come from LineModule.
    LineModule,
    // Reuse kill-switch settings service + recipient resolver.
    NotificationsEmailModule,
  ],
  controllers: [NotificationsLineController],
  providers: [
    NotificationsLineService,
    LineNotificationProcessor,
    FlexTemplateRendererService,
  ],
  exports: [NotificationsLineService],
})
export class NotificationsLineModule {}
