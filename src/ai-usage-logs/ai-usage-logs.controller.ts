import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpStatus,
  HttpCode,
  Query,
  UseGuards,
  ParseUUIDPipe,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { AiUsageLogsService } from './ai-usage-logs.service';
import { CreateAiUsageLogDto } from './dto/create-ai-usage-log.dto';
import { AiUsageLogResponseDto } from './dto/ai-usage-log-response.dto';

@Controller({
  path: 'ai-usage-logs',
  version: '1',
})
export class AiUsageLogsController {
  constructor(private readonly aiUsageLogsService: AiUsageLogsService) { }

  @Post()
  async create(@Body() createAiUsageLogDto: CreateAiUsageLogDto): Promise<AiUsageLogResponseDto> {
    return this.aiUsageLogsService.create(createAiUsageLogDto);
  }

  @Get()
  async findAll(): Promise<AiUsageLogResponseDto[]> {
    return this.aiUsageLogsService.findAll();
  }

  @Get('stats')
  async getStats(@Query('year') year?: number) {
    return this.aiUsageLogsService.getStats(year);
  }

  /**
   * Wave 36 N3 — owner-scoped detail endpoint for one usage log.
   *
   * Returns the full rich detail for the authenticated user's OWN logs
   * only. Ownership is resolved via the existing
   * `ai_usage_logs → ai_usage_quota → user` chain. Mismatch returns 404
   * (not 403) to prevent enumeration (security hardening per §17.3).
   *
   * A dedicated `/:id/detail` path was chosen over reusing `/:id`
   * because the existing `GET /:id` handler has NO ownership
   * enforcement and is consumed by existing callers (e.g. admin
   * tooling) that expect cross-user visibility. Adding owner gating to
   * the existing route would silently break those callers. The new
   * `/:id/detail` route is explicitly owner-scoped for the Profile.tsx
   * detail drawer; the Executive cross-user view is deferred to
   * Wave 36B.
   *
   * §17.2 advisory — this is read-only observability and does NOT
   * gate any workflow transition. §17.11 — `super-admin` cannot
   * bypass ownership via this endpoint.
   */
  @UseGuards(JwtAuthGuard)
  @Get(':id/detail')
  async getDetailForOwner(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<AiUsageLogResponseDto> {
    if (!req.user || !req.user.userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.aiUsageLogsService.findDetailForUser(id, req.user.userId);
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<AiUsageLogResponseDto> {
    return this.aiUsageLogsService.findOne(id);
  }
}
