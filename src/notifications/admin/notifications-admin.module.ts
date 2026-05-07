import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmailModule } from 'src/util/email/email.module';
import { LineModule } from 'src/line/line.module';
import { User } from 'src/users/entities/user.entity';
import { UsersModule } from 'src/users/users.module';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

import { NotificationQuotaAlert } from '../entities/notification-quota-alert.entity';
import { NotificationsEmailModule } from '../email/notifications-email.module';
import { NotificationsLineModule } from '../line/notifications-line.module';

import { NotificationQuotaController } from './notification-quota.controller';
import { NotificationAlertsController } from './notification-alerts.controller';
import { NotificationQuotaAlertsService } from './notification-quota-alerts.service';
import { QuotaAlertWorkerService } from './quota-alert-worker.service';
// W97-API-FORCE-UNLINK — super-admin force-unlink endpoint. Sibling
// W97-API-BINDINGS adds list/reveal methods on the same controller class.
import { LineBindingsAdminController } from './line-bindings.controller';
// BE-03 (auth-roles-guard-unification Phase 3) — RolesGuard is consumed
// via per-method `@UseGuards(JwtAuthGuard, RolesGuard)` in
// `NotificationAlertsController` and `NotificationQuotaController`.
// Register it as a provider so Nest's DI can resolve it (mirrors BE-02's
// edit to `WorkHistoryModule`).
import { RolesGuard } from 'src/auth/roles.guard';

/**
 * Wave 97 — Admin notification dashboard module.
 *
 * Hosts:
 *   - GET    /admin/notifications/quota          (staff-lead read)
 *   - GET    /admin/notifications/alerts         (super-admin)
 *   - POST   /admin/notifications/alerts         (super-admin)
 *   - PATCH  /admin/notifications/alerts/:id     (super-admin)
 *   - DELETE /admin/notifications/alerts/:id     (super-admin)
 *   - Background worker `QuotaAlertWorkerService` (every 5 min via `@Cron`)
 *
 * DI graph:
 *   - `EmailStatsService` resolved from `NotificationsEmailModule` (export)
 *   - `LineStatsService`  resolved from `NotificationsLineModule`  (export)
 *   - `EmailService`      resolved from `EmailModule`              (export)
 *   - `NotificationQuotaAlert` repo bound here via `forFeature`
 *
 * §17.3 audit isolation — `NotificationQuotaAlert` has NO FK into project
 * tables. The `created_by_user_id` FK to `users(id)` is permitted (users
 * are not project tables; ON DELETE SET NULL keeps audit history).
 *
 * §12 — neither the CRUD endpoints nor the worker write `tracking_status`.
 *
 * `ScheduleModule.forRoot()` is registered globally in `AppModule` (W22),
 * so `@Cron(...)` decorators on this module's providers wire up
 * automatically.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      NotificationQuotaAlert,
      // W97-API-FORCE-UNLINK — controller resolves the affected user
      // (for the post-transaction email) + the actor's current
      // WorkHistory (recorded on the audit row's `actor_work_history_id`
      // column per CLAUDE.md §4 ownership-via-WorkHistory pattern).
      User,
      WorkHistory,
    ]),
    NotificationsEmailModule, // exports EmailStatsService
    NotificationsLineModule, // exports LineStatsService (added W97)
    EmailModule, // exports EmailService (W90 chokepoint)
    // W98 follow-up — `QuotaAlertWorkerService` resolves admin /
    // super-admin emails dynamically when an alert row has no
    // `recipientEmail`; needs `UsersService.decryptUserPii(...)`.
    UsersModule,
    // W97-API-FORCE-UNLINK — exports `LineUserBindingService` (extended
    // here with `forceUnlinkByAdmin(...)`). The service injects
    // `LineBindingAdminAction` repo internally via `LineModule`'s
    // forFeature; admin module does NOT need to re-register that entity.
    LineModule,
  ],
  controllers: [
    NotificationQuotaController,
    NotificationAlertsController,
    // W97-API-FORCE-UNLINK + W97-API-BINDINGS share this class.
    LineBindingsAdminController,
  ],
  providers: [
    NotificationQuotaAlertsService,
    QuotaAlertWorkerService,
    // BE-03 — canonical role gate, used by NotificationAlertsController
    // and NotificationQuotaController.
    RolesGuard,
  ],
  exports: [NotificationQuotaAlertsService],
})
export class NotificationsAdminModule {}
