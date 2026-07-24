import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CITIZEN_THROTTLE_TTL_MS } from './constants/citizen-rate-limits';
import { UsersModule } from '../users/users.module';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { RolesGuard } from '../auth/roles.guard';
import { WorkStatusApprovedGuard } from '../auth/work-status-approved.guard';
import { EmailModule } from '../util/email/email.module';
import { CitizenAuthController } from './citizen-auth/citizen-auth.controller';
import { CitizenAuthService } from './citizen-auth/citizen-auth.service';
import { CitizenLoginOtpService } from './citizen-auth/citizen-login-otp.service';
import { CitizenRegistrationOtpService } from './citizen-auth/citizen-registration-otp.service';
import { CitizenPasswordResetService } from './citizen-auth/citizen-password-reset.service';
import { Argon2Service } from '../backup-login/argon2.service';
import { CitizenJwtGuard } from './citizen-auth/citizen-jwt.guard';
import { CitizenOptionalJwtGuard } from './citizen-auth/citizen-optional-jwt.guard';
import { CitizenJwtStrategy } from './citizen-auth/citizen-jwt.strategy';
import { CitizenPostController } from './citizen-post.controller';
import { CitizenPostService } from './citizen-post.service';
import { CitizenMentionService } from './citizen-mention.service';
import { CitizenSearchController } from './citizen-search.controller';
import { CitizenSearchService } from './citizen-search.service';
import { CitizenRepostEmbedService } from './citizen-repost-embed.service';
import { CitizenProfileController } from './citizen-profile.controller';
import { CitizenProfileService } from './citizen-profile.service';
import { CitizenAuditLog } from './entities/citizen-audit-log.entity';
import { CitizenBackendAccessGrant } from './entities/citizen-backend-access-grant.entity';
import { CitizenBookmark } from './entities/citizen-bookmark.entity';
import { CitizenFollow } from './entities/citizen-follow.entity';
import { CitizenIdentity } from './entities/citizen-identity.entity';
import { CitizenModerationLog } from './entities/citizen-moderation-log.entity';
import { CitizenNotification } from './entities/citizen-notification.entity';
import { CitizenPasswordResetToken } from './entities/citizen-password-reset-token.entity';
import { CitizenLoginOtp } from './entities/citizen-login-otp.entity';
import { CitizenSession } from './entities/citizen-session.entity';
import { CitizenSessionRegistryService } from './citizen-auth/citizen-session-registry.service';
import { CitizenSessionMintService } from './citizen-auth/citizen-session-mint.service';
import { CitizenLoginAlertService } from './citizen-auth/citizen-login-alert.service';
import { CitizenSessionController } from './citizen-auth/citizen-session.controller';
import { CitizenRegistrationOtp } from './entities/citizen-registration-otp.entity';
import { CitizenPollOption } from './entities/citizen-poll-option.entity';
import { CitizenPollVote } from './entities/citizen-poll-vote.entity';
import { CitizenHashtag } from './entities/citizen-hashtag.entity';
import { CitizenPostHashtag } from './entities/citizen-post-hashtag.entity';
import { CitizenPost } from './entities/citizen-post.entity';
import { CitizenPostComment } from './entities/citizen-post-comment.entity';
import { CitizenPostCommentReaction } from './entities/citizen-post-comment-reaction.entity';
import { CitizenPostMedia } from './entities/citizen-post-media.entity';
import { CitizenPostReaction } from './entities/citizen-post-reaction.entity';
import { CitizenStory } from './entities/citizen-story.entity';
import { CitizenStoryView } from './entities/citizen-story-view.entity';
import { CitizenStoryReaction } from './entities/citizen-story-reaction.entity';
import { CitizenChatConversation } from './entities/citizen-chat-conversation.entity';
import { CitizenChatMessage } from './entities/citizen-chat-message.entity';
import { CitizenChatReadState } from './entities/citizen-chat-read-state.entity';
import { CitizenChatController } from './chat/citizen-chat.controller';
import { CitizenChatService } from './chat/citizen-chat.service';
import { CitizenChatGateway } from './chat/citizen-chat.gateway';
import { CitizenPresenceService } from './chat/citizen-presence.service';
import { CitizenStoryController } from './stories/citizen-story.controller';
import { CitizenStoryService } from './stories/citizen-story.service';
import { CitizenStoryEngagementService } from './stories/citizen-story-engagement.service';
import { CitizenBookmarkController } from './bookmark/citizen-bookmark.controller';
import { CitizenBookmarkService } from './bookmark/citizen-bookmark.service';
import { CitizenPollController } from './poll/citizen-poll.controller';
import { CitizenPollService } from './poll/citizen-poll.service';
import { CitizenHashtagController } from './hashtag/citizen-hashtag.controller';
import { CitizenHashtagService } from './hashtag/citizen-hashtag.service';
import { CitizenFollowController } from './follow/citizen-follow.controller';
import { CitizenFollowService } from './follow/citizen-follow.service';
import { CitizenMediaController } from './media/citizen-media.controller';
import { CitizenMediaService } from './media/citizen-media.service';
import { CitizenMediaModerationService } from './media/citizen-media-moderation.service';
import { CitizenStorageService } from './media/citizen-storage.service';
import { CitizenAvatarService } from './media/citizen-avatar.service';
import { CitizenNotificationBus } from './notification/citizen-notification.bus';
import { CitizenNotificationController } from './notification/citizen-notification.controller';
import { CitizenNotificationService } from './notification/citizen-notification.service';
import { CitizenOfficialResponse } from './entities/citizen-official-response.entity';
import { CitizenGrantController } from './grant/citizen-grant.controller';
import { CitizenGrantService } from './grant/citizen-grant.service';
import { CitizenRespondGrantGuard } from './grant/citizen-respond-grant.guard';
import { CitizenOfficialResponseController } from './official-response/citizen-official-response.controller';
import { CitizenOfficialResponseService } from './official-response/citizen-official-response.service';
import { CitizenReport } from './entities/citizen-report.entity';
import { CitizenAppeal } from './entities/citizen-appeal.entity';
import { CitizenModerationController } from './moderation/citizen-moderation.controller';
import { CitizenModerationService } from './moderation/citizen-moderation.service';
import { CitizenModerateGrantGuard } from './moderation/citizen-moderate-grant.guard';
import { CitizenAppealController } from './moderation/citizen-appeal.controller';
import { CitizenAppealService } from './moderation/citizen-appeal.service';
// W-T4 — staff moderation RISK DASHBOARD (§18.13 zero-write read aggregator;
// gated by the SAME `moderate` grant as the W-T3/C5 queue). No new entity /
// FK / migration — reads existing citizen_* moderation signals only.
import { CitizenModerationInsightsController } from './moderation/citizen-moderation-insights.controller';
import { CitizenModerationInsightsService } from './moderation/citizen-moderation-insights.service';
import { CitizenBlock } from './entities/citizen-block.entity';
import { CitizenBlockController } from './block/citizen-block.controller';
import { CitizenBlockService } from './block/citizen-block.service';
import { GeoBoundaryService } from '../ai/geo-boundary.service';
import { CitizenMention } from './entities/citizen-mention.entity';
import { CitizenDsarController } from './dsar/citizen-dsar.controller';
import { CitizenDsarService } from './dsar/citizen-dsar.service';
// W-G3 — executive insights read aggregator (§18.13 zero-write, EXEC_READ-gated).
import { CitizenInsightsController } from './insights/citizen-insights.controller';
import { CitizenInsightsService } from './insights/citizen-insights.service';
// W-P4 — civic gamification badges, computed-on-read (§18.13 zero-write; no new
// entity / FK / migration — reads existing citizen_* counts only).
import { CitizenAchievementsController } from './achievements/citizen-achievements.controller';
import { CitizenAchievementsService } from './achievements/citizen-achievements.service';
// PDPA on-disk blob sweeper — purges orphaned story/media image bytes after
// expiry / soft-delete (§17.3 isolation; citizen_* + storage seam only).
import { CitizenRetentionCron } from './citizen-retention.cron';

/**
 * CitizenEngagementModule — the isolated civic-community engagement layer.
 *
 * M0 (schema + isolation): registers the `citizen_*` entities only. Services,
 * controllers, ThaID auth, moderation, and aggregation are added in later
 * milestones (M1+). Every entity here is ALSO registered in the root
 * `TypeOrmModule.forRoot({ entities })` in app.module.ts (required — the root
 * uses an explicit entities array, not autoLoadEntities).
 *
 * §17.2 advisory / §17.3 isolation: this module owns NO project / workflow
 * data, writes NO `tracking_status`, and its tables hold ZERO FK into any
 * project table / users / work_history.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CitizenIdentity,
      // Password-reset tokens for the email/password citizen login. Isolated
      // `citizen_*` namespace; `identity_id` is a PLAIN uuid (NO FK), mirroring
      // citizen_audit_logs so a PDPA erase never cascades (§17.3). Stores only
      // the token HASH, never plaintext.
      CitizenPasswordResetToken,
      // Mandatory email-OTP 2FA challenges for the citizen login. Isolated
      // `citizen_*` namespace; `identity_id` is a PLAIN uuid (NO FK), mirroring
      // citizen_password_reset_tokens so a PDPA erase never cascades (§17.3).
      // Stores only the code HASH, never the plaintext 6-digit code.
      CitizenLoginOtp,
      // Per-session (per-device) registry for the citizen cohort. Isolated
      // `citizen_*` namespace; `identity_id` is a PLAIN uuid (NO FK), so a PDPA
      // erase never cascades (§17.3). The PK IS the JWT `sid`; the client IP is
      // AES-encrypted (`ip_enc`). Enforcement is flag-gated (SESSION_REGISTRY_ENABLED).
      CitizenSession,
      // Verify-email-first registration OTP challenges. Isolated `citizen_*`
      // namespace with NO identity_id / NO FK at all — the identity does not
      // exist until `register/complete` creates it (§17.3), so there are never
      // orphan identities. Stores only the code HASH (a random DECOY for the
      // existing-email anti-enum branch); the email is AES-encrypted.
      CitizenRegistrationOtp,
      CitizenPost,
      CitizenPostComment,
      CitizenPostCommentReaction,
      CitizenPostReaction,
      CitizenPostMedia,
      CitizenModerationLog,
      CitizenBackendAccessGrant,
      CitizenAuditLog,
      CitizenFollow,
      CitizenNotification,
      CitizenOfficialResponse,
      CitizenReport,
      CitizenBookmark,
      CitizenPollOption,
      CitizenPollVote,
      // W-S4 hashtags + trending — isolated `citizen_*` namespace; the dictionary
      // has NO FK, the link has FKs only into citizen_post / citizen_hashtag (§17.3).
      CitizenHashtag,
      CitizenPostHashtag,
      // W-GATE-3 ephemeral 24h stories — isolated `citizen_*` namespace; the
      // only FK is author_identity_id → citizen_identities (§17.3).
      CitizenStory,
      // FB-6 story VIEW tracking + emoji REACTIONS — isolated `citizen_*`
      // namespace; story_id / viewer_identity_id / identity_id are ALL PLAIN
      // uuid (NO FK), so a PDPA erase never cascades and the 24h retention sweep
      // purges independently (§17.3).
      CitizenStoryView,
      CitizenStoryReaction,
      // W-T1 block/mute — isolated `citizen_*` namespace; the only FK is
      // blocker_identity_id → citizen_identities (§17.3). blocked_identity_id is
      // a PLAIN uuid (no FK), like citizen_follow.target_key.
      CitizenBlock,
      // W-T3 moderation v2 appeals — isolated `citizen_*` namespace; FKs only
      // into citizen_post / citizen_identities (§17.3). The resolving staff
      // member is a PLAIN uuid + SNAPSHOT name (no FK), like C4.
      CitizenAppeal,
      // W-S6 @mention — isolated `citizen_*` namespace; FKs only into
      // citizen_post / citizen_identities (§17.3). `comment_id` is a PLAIN uuid
      // (no FK), like citizen_notification.comment_id.
      CitizenMention,
      // Community Chat — isolated `citizen_*` namespace; the conversation's only
      // FK is initiator_identity_id → citizen_identities (participant is a PLAIN
      // uuid), messages/read-state FK only into citizen_chat_* + citizen_identities
      // (§17.3). Message bodies are encrypted at rest.
      CitizenChatConversation,
      CitizenChatMessage,
      CitizenChatReadState,
      // W-G3 — `WorkStatusApprovedGuard` (auth-layer, NOT data) injects a
      // `Repository<WorkHistory>` for the §2 live work-status read on the
      // EXEC_READ-gated insights routes. This is an AUTHORIZATION dependency on
      // the existing auth table, NOT a citizen_* → work_history data FK — the
      // §17.3 isolation invariant (entity/migration-level, asserted by the
      // isolation spec which scans only entities/ + migrations/) is intact.
      // Mirrors `unified-projects.module.ts` / `ai-executive-chat.module.ts`.
      WorkHistory,
    ]),
    PassportModule,
    // The citizen JWT is signed per-call with an explicit secret + `aud`
    // (CitizenAuthService.sign), so JwtModule only needs to provide JwtService.
    JwtModule.register({}),
    // W-SEC-2 — Module-scoped throttler. This app has NO global APP_GUARD
    // ThrottlerGuard, so rate-limit enforcement is opt-in: the single
    // default-tracker entry lets the controllers' `@Throttle({ default: ... })`
    // resolve, and each throttled route ALSO lists `ThrottlerGuard` in its
    // `@UseGuards(...)`. Mirrors users.module.ts / line.module.ts. The fallback
    // limit applies only to throttled routes that don't set a tighter per-route
    // `@Throttle` (the citizen write/auth routes all do — see citizen-rate-limits.ts).
    ThrottlerModule.forRoot([
      { name: 'default', ttl: CITIZEN_THROTTLE_TTL_MS, limit: 100 },
    ]),
    // C4: the official-response controller snapshots the responder's staff name
    // + agency via UsersService (a CONTROLLER-layer bridge — plain strings into
    // citizen_* columns, no data FK; §17.3 table-level invariant intact).
    UsersModule,
    // AUTH-REDESIGN §3.2 follow-up — the sandbox-aware EmailService chokepoint
    // for the citizen password-reset transactional email. NOT the staff
    // NotificationsEmailService (which is coupled to the `users` table).
    EmailModule,
  ],
  controllers: [
    CitizenAuthController,
    // Batch 2 — citizen device/session self-management (list + revoke +
    // revoke-others), gated by CitizenJwtGuard.
    CitizenSessionController,
    CitizenPostController,
    CitizenSearchController,
    CitizenProfileController,
    CitizenMediaController,
    CitizenFollowController,
    CitizenNotificationController,
    CitizenGrantController,
    CitizenOfficialResponseController,
    CitizenModerationController,
    CitizenModerationInsightsController,
    CitizenAppealController,
    CitizenBookmarkController,
    CitizenPollController,
    CitizenHashtagController,
    CitizenStoryController,
    CitizenBlockController,
    CitizenChatController,
    CitizenDsarController,
    CitizenInsightsController,
    CitizenAchievementsController,
  ],
  providers: [
    CitizenAuthService,
    // AUTH-REDESIGN §3.2 follow-up — email/password reset flow (token issue +
    // consume). Uses the reset-token repo (forFeature above), Argon2Service,
    // and the sandbox-aware EmailService (EmailModule).
    CitizenPasswordResetService,
    // Mandatory email-OTP 2FA — issues/verifies/resends the login OTP challenge
    // and mints the real session on verify. Injected by CitizenAuthService
    // (one-way; no DI cycle) and the two /login/otp* controller routes.
    CitizenLoginOtpService,
    // Verify-email-first 3-step registration (request-otp / verify-otp /
    // otp/resend / complete). Creates the citizen_identities row ONLY at
    // complete (no orphan identities). Self-contained — uses the registration-otp
    // repo (forFeature above), Argon2Service, JwtService, EmailService, DataSource.
    CitizenRegistrationOtpService,
    // AUTH-REDESIGN (2026-07-08) — Argon2id hashing for citizen
    // email/password register + login. Standalone injectable (no deps),
    // provided directly so CitizenAuthService can inject it without
    // importing BackupLoginModule.
    Argon2Service,
    // Per-session registry (login-alerts / device-session-management, Batch 1).
    // Injected by CitizenJwtStrategy for flag-gated per-session revocation;
    // exposes record/revoke/revokeOthers for Batch 2's mint + device-manager.
    CitizenSessionRegistryService,
    // Batch 2 — the mint seam (records a session + fires the new-device alert,
    // both flag-gated) called by the three citizen mint points, and the
    // self-contained "แผนชัด" new-device alert email service.
    CitizenSessionMintService,
    CitizenLoginAlertService,
    CitizenJwtStrategy,
    CitizenJwtGuard,
    CitizenOptionalJwtGuard,
    CitizenPostService,
    CitizenMentionService,
    CitizenSearchService,
    CitizenRepostEmbedService,
    CitizenProfileService,
    CitizenMediaService,
    // W-M1 — content-moderation seam (config-gated, fail-closed). Imports only
    // nest + axios (a third-party HTTP client, not a project service), so it
    // cannot participate in a service↔service import cycle.
    CitizenMediaModerationService,
    CitizenStorageService,
    CitizenAvatarService,
    CitizenFollowService,
    // W-T2 — in-memory realtime fan-out for the notification SSE stream.
    CitizenNotificationBus,
    CitizenNotificationService,
    CitizenGrantService,
    CitizenOfficialResponseService,
    CitizenRespondGrantGuard,
    CitizenModerationService,
    CitizenModerateGrantGuard,
    // W-T4 — risk-dashboard aggregator (read-only; reuses the citizen_* repos
    // already registered via TypeOrmModule.forFeature + the moderate guard).
    CitizenModerationInsightsService,
    CitizenAppealService,
    CitizenBookmarkService,
    CitizenPollService,
    CitizenHashtagService,
    CitizenStoryService,
    // FB-6 — story VIEW tracking + emoji REACTIONS + owner-only audience page.
    // Reuses the citizen_story* repos (forFeature above) + CitizenBlockService.
    CitizenStoryEngagementService,
    CitizenBlockService,
    CitizenChatService,
    CitizenChatGateway,
    CitizenPresenceService,
    CitizenDsarService,
    // W-G3 — executive insights aggregator + the auth guards its controller
    // composes (registered here so DI resolves them without leaning on the
    // owning auth module; mirrors `UnifiedProjectsModule` / `AiExecutiveChatModule`).
    CitizenInsightsService,
    // W-P4 — gamification badge aggregator (read-only; uses the existing
    // citizen_* repositories already registered via TypeOrmModule.forFeature).
    CitizenAchievementsService,
    RolesGuard,
    WorkStatusApprovedGuard,
    // PDPA blob retention sweeper (daily @Cron via the global ScheduleModule).
    CitizenRetentionCron,
    // Point-in-polygon amphoe resolver — derives an idea's amphoe code from its
    // pin (lat/lng) at create time. Self-contained (loads geojson at init, no
    // deps), provided directly like `ProjectGroupsModule` does.
    GeoBoundaryService,
  ],
  exports: [CitizenAuthService],
})
export class CitizenEngagementModule {}
