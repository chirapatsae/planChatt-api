import { Controller, Delete, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { JwtAuthGuard } from '../../auth/auth.guard';
import { UsersDsarService } from './users-dsar.service';

/**
 * Staff PDPA DSAR surface (AUTH-REDESIGN §6). Mirrors the citizen
 * `citizen-engagement/me` routes. A staff user can only ever export / erase
 * their OWN account — the id is derived from the JWT `sub`, never a param
 * (no IDOR). Both routes require a valid staff session.
 *
 *   GET    /api/v1/users/me/data-export
 *   DELETE /api/v1/users/me/account
 */
@Controller({ path: 'users/me', version: '1' })
export class UsersDsarController {
  constructor(private readonly dsar: UsersDsarService) {}

  /** RIGHT-OF-ACCESS — one JSON object of everything we hold about the caller. */
  @Get('data-export')
  @UseGuards(JwtAuthGuard)
  async dataExport(@Req() req: Request & { user: { userId: string } }) {
    return this.dsar.exportMine(req.user.userId);
  }

  /** RIGHT-TO-ERASURE — anonymize + soft-delete the caller's own account. */
  @Delete('account')
  @UseGuards(JwtAuthGuard)
  async eraseAccount(@Req() req: Request & { user: { userId: string } }) {
    return this.dsar.eraseMine(req.user.userId);
  }
}
