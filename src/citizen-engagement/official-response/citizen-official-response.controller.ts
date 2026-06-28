import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/auth.guard';
import { UsersService } from '../../users/users.service';
import { CreateOfficialResponseDto } from '../dto/create-official-response.dto';
import { UpdateOfficialResponseStatusDto } from '../dto/update-official-response-status.dto';
import { CitizenRespondGrantGuard } from '../grant/citizen-respond-grant.guard';
import {
  CitizenOfficialResponseService,
  OfficialResponder,
} from './citizen-official-response.service';

/** `req.user` shape set by JwtAuthGuard / JwtStrategy (INTERNAL identity). */
interface InternalRequest {
  user: { userId: string; role: string };
}

/**
 * Official-response write surface (C4, plan D12).
 *
 * INTERNAL identity ONLY: `JwtAuthGuard` (requires the `secret-key` header +
 * staff Bearer token) THEN `CitizenRespondGrantGuard` (requires a live
 * `respond` grant — the authoritative BE gate, 403 CITIZEN_RESPOND_NOT_GRANTED
 * otherwise). The responder snapshot is resolved from the JWT context, NEVER
 * from the body (§17.3 — snapshotted as plain strings, no FK).
 */
@Controller({ path: 'citizen-engagement', version: '1' })
export class CitizenOfficialResponseController {
  constructor(
    private readonly officialResponseService: CitizenOfficialResponseService,
    private readonly usersService: UsersService,
  ) {}

  @Post('posts/:id/official-response')
  @UseGuards(JwtAuthGuard, CitizenRespondGrantGuard)
  async respond(
    @Req() req: InternalRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateOfficialResponseDto,
  ) {
    const responder = await this.resolveResponder(req.user.userId);
    return this.officialResponseService.respond(responder, id, dto.body);
  }

  /**
   * W-G2: advance an official response's issue-handling status. Same INTERNAL
   * gate as `respond` — `JwtAuthGuard` THEN `CitizenRespondGrantGuard` (the C4
   * `respond` grant is the authority, NOT ownership, §4.1). Forward-or-same
   * only; the service rejects a backward move with
   * `400 OFFICIAL_RESPONSE_STATUS_INVALID`.
   */
  @Patch('official-response/:id/status')
  @UseGuards(JwtAuthGuard, CitizenRespondGrantGuard)
  async updateStatus(
    @Req() req: InternalRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateOfficialResponseStatusDto,
  ) {
    const responder = await this.resolveResponder(req.user.userId);
    return this.officialResponseService.updateStatus(responder, id, dto.status);
  }

  /**
   * Snapshot the responder's name + CURRENT-WorkHistory agency at action time
   * (§17.3 — plain strings into citizen_* columns, no FK). Falls back to the
   * userId for `workHistoryId` when the user has no current WorkHistory — still
   * a plain uuid either way. Resolved from the JWT context, NEVER the body.
   */
  private async resolveResponder(userId: string): Promise<OfficialResponder> {
    const user = await this.usersService.findOne(userId);
    const displayName = `${user?.firstname ?? ''} ${user?.lastname ?? ''}`.trim();
    const current = user?.workHistory?.find((wh) => wh.isCurrent);
    const agencyName = current?.governmentAgencies?.name ?? null;
    const workHistoryId = current?.id ?? userId;
    return { userId, workHistoryId, displayName, agencyName };
  }
}
