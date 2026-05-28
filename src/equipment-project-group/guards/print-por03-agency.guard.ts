import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { assertAgencyCaller } from '../helpers/print-por03-authz.helper';

/**
 * Wave Print ผ.03 — BE-02 (2026-05-28).
 *
 * `PrintPor03AgencyGuard` — Layer-1 controller guard for the user-side
 * print endpoint `POST /v1/pdf/generate-por03` (Q4 LOCKED).
 *
 * Implements check (a) of the BE-02 defense-in-depth contract:
 *   - Loads the caller's current (`isCurrent = true`) WorkHistory.
 *   - Delegates to `assertAgencyCaller(workHistory)` from the shared
 *     helper so the guard layer and BE-01's service layer execute the
 *     SAME predicate (single source of truth — §5.3 defense-in-depth).
 *
 * Per-row checks (b) owner check and (c) STRATEGY_BASED shape check live
 * in the service layer (they require the loaded `EquipmentProjectGroup`
 * row). BE-01's `Por03PdfService` is expected to invoke
 * `assertOwnership` + `assertStrategyShape` per loaded row after this
 * guard hands off the request.
 *
 * # Composition contract (LOCKED — coordinated with BE-01)
 *
 *   @Controller({ path: 'pdf', version: '1' })
 *   @UseGuards(JwtAuthGuard, WorkStatusApprovedGuard)
 *   export class PdfController {
 *     @Post('generate-por03')
 *     @UseGuards(PrintPor03AgencyGuard)
 *     async generatePor03(@Body() dto, @Req() req) { ... }
 *   }
 *
 * - MUST run AFTER `JwtAuthGuard` so `req.user.userId` is populated.
 * - MUST run AFTER (or alongside) `WorkStatusApprovedGuard` so a
 *   non-approved workStatus is rejected before this guard incurs the
 *   DB read. The two guards are independent; ordering only matters
 *   relative to JwtAuthGuard.
 * - The guard pins `req.callerWorkHistoryId` onto the request so BE-01's
 *   service can read it directly without re-resolving the WorkHistory.
 *   The pinned value is the caller's current WorkHistory `id` (used by
 *   the §4 ownership comparison in the service layer).
 *
 * # Error contract
 *
 *   - 401 UNAUTHENTICATED          — `req.user.userId` missing (guard
 *                                    ordering bug — JwtAuthGuard didn't
 *                                    run first).
 *   - 401 UNAUTHENTICATED          — current WorkHistory missing (no
 *                                    `isCurrent = true` row for the user).
 *   - 403 EQUIPMENT_AGENCY_ONLY    — caller's classification per §1 is
 *                                    `lao` (or any non-agency shape).
 *                                    Re-thrown verbatim from the helper.
 *
 * # Q1–Q6 locked answers acknowledged (verbatim, README §0, 2026-05-28)
 *
 * - Q2 (STRATEGY_BASED ONLY) — enforced by `assertStrategyShape` at
 *   service layer; NOT this guard.
 * - Q4 (endpoint `POST /v1/pdf/generate-por03`) — the surface this guard
 *   attaches to.
 * - Q5 (skip audit) — this guard writes NO audit / tracking-status rows.
 * - Q6 (cooldown owned by BE-01) — this guard does NOT arm the §17.8
 *   cooldown. Authz 4xx errors MUST NOT arm cooldown (per BE-02 brief).
 *
 * # No role exemption (§17.11)
 *
 * `role` is NOT inspected. A LAO super-admin is rejected with
 * `403 EQUIPMENT_AGENCY_ONLY` exactly like a LAO `user`. Authority does
 * NOT widen by role — classification is the gate.
 *
 * # Dual-pattern note
 *
 * This guard mirrors the existing `AgencyOnlyGuard`
 * (`backend/src/common/guards/agency-only.guard.ts`) byte-for-spirit
 * (same relations list, same `isCurrent = true` filter). It lives in
 * the equipment-project-group module rather than `common/guards` so the
 * Wave Print ผ.03 surface stays self-contained — the BE-01 PDF endpoint
 * imports both the guard and the helper from the same module without
 * pulling on `common/`.
 */
@Injectable()
export class PrintPor03AgencyGuard implements CanActivate {
  constructor(
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      user?: { userId?: string };
      callerWorkHistoryId?: string;
    }>();

    const userId = request?.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }

    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['amphoe', 'localAdministrativeOrganization'],
    });

    if (!workHistory) {
      // §1 source of truth requires a current WorkHistory to classify the
      // caller. Missing WorkHistory is treated as an authentication-state
      // failure (not a forbidden authorization decision).
      throw new UnauthorizedException('UNAUTHENTICATED');
    }

    // Layer-1 enforcement — single-sourced via the shared helper. BE-01's
    // service layer re-asserts the identical predicate post-row-load.
    assertAgencyCaller(workHistory);

    // Pin the current WorkHistory id so BE-01's service can perform the
    // §4 ownership comparison without re-loading WorkHistory.
    request.callerWorkHistoryId = workHistory.id;

    return true;
  }
}
