/**
 * W106-BE-PR1 — PresenceController
 *
 * REST surface for the presence subsystem. All endpoints JWT-guarded
 * (`JwtAuthGuard` from `src/auth/auth.guard.ts`, which enforces both the
 * Bearer token AND the `secret-key` header used elsewhere in the app).
 *
 * Endpoints:
 *   POST /v1/presence/heartbeat  → 204 (idempotent)
 *   GET  /v1/presence?userIds=…  → bulk map
 *   GET  /v1/presence/me         → caller's own presence (always online)
 *
 * §17.2 / §4.1: presence is advisory metadata only. None of these endpoints
 * gate any workflow transition or alter authority.
 */

import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import {
  BulkPresenceQueryDto,
  PRESENCE_BULK_MAX,
} from './dto/bulk-presence-query.dto';
import { PresenceService } from './presence.service';

@Controller({ path: 'presence', version: '1' })
@UseGuards(JwtAuthGuard)
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  /**
   * POST /v1/presence/heartbeat
   *
   * Idempotent ping. Always returns 204 (even when the inner debounce gate
   * skips the SQL UPDATE), so clients can call this on a fixed cadence
   * without branching on response status.
   */
  @Post('heartbeat')
  @HttpCode(204)
  async heartbeat(
    @Request() req: Request & { user: JwtPayloadUser },
  ): Promise<void> {
    await this.presence.markOnline(req.user.userId, 'http');
  }

  /**
   * GET /v1/presence?userIds=a,b,c
   *
   * Returns a `{ userId: { online, lastSeen } }` map. Soft-deleted users
   * are returned with `online=false, lastSeen=null` (never leak).
   *
   * Validation:
   *   - 0 ids   → 400 (ArrayMinSize)
   *   - >200    → 400 with explicit `PRESENCE_BULK_LIMIT_EXCEEDED` code
   *   - non-UUID→ 400
   */
  @Get()
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      // We hand-pick error messages so the limit-exceeded code surfaces
      // verbatim to the client (matches the §17 error-code convention).
      exceptionFactory: (errors) => {
        const flat: string[] = [];
        for (const e of errors) {
          if (e.constraints) {
            for (const v of Object.values(e.constraints)) {
              flat.push(String(v));
            }
          }
        }
        if (flat.includes('PRESENCE_BULK_LIMIT_EXCEEDED')) {
          return new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            message: 'PRESENCE_BULK_LIMIT_EXCEEDED',
            limit: PRESENCE_BULK_MAX,
          });
        }
        return new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          message: flat.length ? flat : 'Invalid presence query',
        });
      },
    }),
  )
  async bulk(
    @Query() query: BulkPresenceQueryDto,
  ): Promise<Record<string, { online: boolean; lastSeen: string | null }>> {
    const map = await this.presence.getPresenceBulk(query.userIds);
    // Serialize Date → ISO string for over-the-wire stability.
    const out: Record<string, { online: boolean; lastSeen: string | null }> = {};
    for (const [k, v] of Object.entries(map)) {
      out[k] = {
        online: v.online,
        lastSeen: v.lastSeen ? v.lastSeen.toISOString() : null,
      };
    }
    return out;
  }

  /**
   * GET /v1/presence/me
   *
   * Self-introspection. The caller is, by definition, online for the
   * duration of this request — they just authenticated. We also touch
   * the heartbeat path so calling /me serves as an implicit ping.
   */
  @Get('me')
  async me(
    @Request() req: Request & { user: JwtPayloadUser },
  ): Promise<{ online: true; lastSeen: string }> {
    await this.presence.markOnline(req.user.userId, 'http');
    return {
      online: true,
      lastSeen: new Date().toISOString(),
    };
  }
}
