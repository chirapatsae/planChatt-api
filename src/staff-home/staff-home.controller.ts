import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { StaffHomeService } from './staff-home.service';
import { StaffOverdueResponseDto } from './dto/staff-overdue.dto';

/**
 * Staff Home dashboard — Phase 2 aging/overdue aggregator.
 *
 * Wave: wave-staff-review-dashboard (PHASE2-BE-01).
 * Contract: docs/tasks/wave-staff-review-dashboard/PHASE2-DOCS-02-RESULT-aging-aggregator-contract.md
 *
 * Read-only per CLAUDE.md §17.2 (advisory) + §18.13 (read-side aggregator
 * allowance). Area-scoped per §3 / §4.1. Authority gate (staff-lead +
 * workStatus=approved) is enforced in the service.
 */
@Controller({ path: 'staff-home', version: '1' })
@UseGuards(JwtAuthGuard)
export class StaffHomeController {
  constructor(private readonly staffHomeService: StaffHomeService) {}

  @Get('overdue')
  async getOverdue(
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<StaffOverdueResponseDto> {
    return this.staffHomeService.getOverdue(req.user.userId);
  }
}
