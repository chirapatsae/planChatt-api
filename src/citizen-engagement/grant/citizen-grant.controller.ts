import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/auth.guard';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import { Role } from '../../auth/roles.enum';
import { UsersService } from '../../users/users.service';
import { GrantCapabilityDto } from '../dto/grant-capability.dto';
import { CitizenGrantService } from './citizen-grant.service';

/** `req.user` shape set by JwtAuthGuard / JwtStrategy (INTERNAL identity). */
interface InternalRequest {
  user: { userId: string; role: string };
}

/**
 * Backend-access grant console (C4, plan D6).
 *
 * INTERNAL identity ONLY (JwtAuthGuard requires the `secret-key` header + a
 * staff Bearer token; a citizen token can NOT satisfy it). Grant/revoke/list
 * are super-admin only; `me` is any authenticated internal user reading their
 * OWN grants.
 */
@Controller({ path: 'citizen-engagement/grants', version: '1' })
export class CitizenGrantController {
  constructor(
    private readonly grantService: CitizenGrantService,
    private readonly usersService: UsersService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async grant(@Req() req: InternalRequest, @Body() dto: GrantCapabilityDto) {
    const deciderWhId = await this.resolveWorkHistoryId(req.user.userId);
    return this.grantService.grant(deciderWhId, dto.userId, dto.capability);
  }

  @Post('revoke')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async revoke(@Req() req: InternalRequest, @Body() dto: GrantCapabilityDto) {
    const deciderWhId = await this.resolveWorkHistoryId(req.user.userId);
    return this.grantService.revoke(deciderWhId, dto.userId, dto.capability);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  listGrants() {
    return this.grantService.listGrants();
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  myGrants(@Req() req: InternalRequest) {
    return this.grantService.myGrants(req.user.userId);
  }

  /**
   * Resolve the decider's CURRENT WorkHistory id from the JWT `userId`.
   *
   * §17.3: the value is persisted as a PLAIN uuid with NO FK. We store the
   * WorkHistory id (the action's organizational context, §4) when available;
   * if the user has no current WorkHistory row we FALL BACK to the plain
   * `userId` uuid — either way it stays a plain uuid in `decided_by_work_
   * history_id` and never becomes a relation.
   */
  private async resolveWorkHistoryId(userId: string): Promise<string> {
    const user = await this.usersService.findOne(userId);
    const current = user?.workHistory?.find((wh) => wh.isCurrent);
    return current?.id ?? userId;
  }
}
