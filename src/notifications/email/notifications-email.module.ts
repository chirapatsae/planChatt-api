import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from 'src/users/entities/user.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { WorkHistoryAmphoeResponsibility } from 'src/work-history-amphoe-responsibility/entities/work-history-amphoe-responsibility.entity';
import { WorkHistoryGovernmentAgencyResponsibility } from 'src/work-history-government-agency-responsibility/entities/work-history-government-agency-responsibility.entity';
// W96-RECIPIENT-RESOLVER — read-only access to active LINE bindings for
// the `enrichWithLineBindings` method on RecipientResolverService.
import { LineUserBinding } from 'src/line/entities/line-user-binding.entity';
import { NotificationEmailLog } from '../entities/notification-email-log.entity';
// Wave 22 B2 — global email kill-switch config + audit trail.
import { NotificationSetting } from '../entities/notification-settings.entity';
import { NotificationSettingsAudit } from '../entities/notification-settings-audit.entity';
import { EmailModule } from 'src/util/email/email.module';
import { RolesGuard } from 'src/auth/roles.guard';

import {
  NotificationsEmailService,
  NOTIFICATIONS_EMAIL_QUEUE,
} from './notifications-email.service';
import { EmailNotificationProcessor } from './email-notification.processor';
import { RecipientResolverService } from './recipient-resolver.service';
import { TemplateRendererService } from './template-renderer.service';
// Wave 22 B1 — super-admin email-stats dashboard surface.
import { EmailStatsService } from './email-stats.service';
import { EmailStatsController } from './email-stats.controller';
// Wave 22 B2 — super-admin email kill-switch surface.
import { NotificationSettingsService } from './notification-settings.service';
import { NotificationSettingsController } from './notification-settings.controller';
// W93-VERIFY-API — public stateless action-link verifier endpoint.
import { ActionLinkVerifyController } from './action-link-verify.controller';

/**
 * Wave 21 — Email notification module (Option C wrapper).
 *
 * Housed under `backend/src/notifications/email/` to avoid symbol
 * collision with the pre-existing `NotificationsModule` / `NotificationsService`
 * in the same folder (which drives the announcements/in-app notification
 * pipeline). See the N1 dispatch report for the rationale.
 *
 * This module:
 *   - Registers Bull queue `notifications-email` (distinct from the existing
 *     `announcements` queue so consumer pools do not mix).
 *   - Imports `EmailModule` to gain access to the existing `EmailService`
 *     (Option C wrapper — NO new provider stack here).
 *   - Exposes `NotificationsEmailService` for N4 to emit into from its
 *     `@OnEvent('notification.*')` handlers.
 *
 * No controllers are registered — workflow emit points are owned by N4
 * and the preferences endpoint is owned by N3.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: NOTIFICATIONS_EMAIL_QUEUE }),
    TypeOrmModule.forFeature([
      User,
      WorkHistory,
      WorkHistoryAmphoeResponsibility,
      WorkHistoryGovernmentAgencyResponsibility,
      NotificationEmailLog,
      // Wave 22 B2 — kill-switch storage.
      NotificationSetting,
      NotificationSettingsAudit,
      // W96-RECIPIENT-RESOLVER — RecipientResolverService.enrichWithLineBindings
      // reads `line_user_bindings` directly (single batched query). Re-registering
      // the entity here is safe and additive; LineModule still owns the write
      // surface (binding link/unlink), this is read-only.
      LineUserBinding,
    ]),
    EmailModule,
  ],
  controllers: [
    EmailStatsController,
    NotificationSettingsController,
    ActionLinkVerifyController,
  ],
  providers: [
    NotificationsEmailService,
    EmailNotificationProcessor,
    RecipientResolverService,
    TemplateRendererService,
    EmailStatsService,
    NotificationSettingsService,
    RolesGuard,
  ],
  exports: [
    NotificationsEmailService,
    RecipientResolverService,
    NotificationSettingsService,
    // Wave 97 — admin module re-uses the email stats aggregator for the
    // combined quota endpoint and the alert worker.
    EmailStatsService,
  ],
})
export class NotificationsEmailModule {}
