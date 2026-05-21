import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Header,
  Logger,
  UseGuards,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import { CreateStrategyDto } from './dto/create-strategy.dto';
import { UpdateStrategyDto } from './dto/update-strategy.dto';
import { StrategyService } from './strategy.service';
import { StrategyCriteriaResponseDto } from './dto/strategy-criteria-response.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { IssueCriteriaRegistryService } from 'src/ai/criteria/issue-criteria-registry.service';
import { ProvinceCode } from 'src/ai/criteria/issue-criteria.types';

@Controller({
  path: 'strategy',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class StrategyController {
  private readonly logger = new Logger(StrategyController.name);

  constructor(
    private readonly strategyService: StrategyService,
    private readonly issueCriteriaRegistryService: IssueCriteriaRegistryService,
  ) {}

  @Post()
  create(
    @Body() dto: CreateStrategyDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(`Request to create strategy with ID: ${dto.stratId}`);
    return this.strategyService.create(dto, req.user.userId);
  }

  @Get()
  findAll() {
    this.logger.log('Request to fetch all strategies');
    return this.strategyService.findAll();
  }

  /**
   * GET /v1/strategy/:id/criteria — Wave LAO-ISSUE-STRATEGY-PARITY N1.
   *
   * Returns the issue-criteria registry entries that match a Strategy by
   * its name (1-to-many — a Strategy may resolve to multiple entries; see
   * STRAT003 / STRAT004 in the registry). Response carries an ARRAY of
   * entries, NOT a single entry — this is the load-bearing shape
   * difference vs `GET /v1/development-issue/:id/criteria`.
   *
   * Status contract:
   *   - 200 with `entries: []`  — Strategy exists but no registry entry
   *                                matches its name (STRAT005 case). FE
   *                                hides panel cleanly. NOT a 404.
   *   - 200 with `entries: [...]` — Strategy exists and one or more
   *                                registry entries match.
   *   - 404                     — Strategy id is unknown or soft-deleted.
   *   - 401                     — caller is not authenticated.
   *
   * Auth: any authenticated user can call — advisory data, no role gate
   * (CLAUDE.md §17.2 / architecture §5.1, mirrors the precedent set by
   * `/v1/development-issue/:id/criteria`).
   *
   * Province resolution: Wave 24 hardcodes `NAKHON_RATCHASIMA`. Wave 25
   * will derive the province from the caller's current WorkHistory.
   *
   * Response is safe to cache per-user for 5 minutes — rules are static
   * in-code constants.
   */
  @Get(':id/criteria')
  @Header('Cache-Control', 'private, max-age=300')
  async findCriteriaByStrategyId(
    @Param('id') id: string,
  ): Promise<StrategyCriteriaResponseDto> {
    // 2026-05-21 — reconciled with BE-RESOLVER's frozen signature:
    // `findAllByStrategyName(name: string): IssueRuleEntry[]`.
    // Step 1: load Strategy row via existing service (throws 404
    // internally on unknown id). Step 2: resolve criteria by name.
    const provinceCode: ProvinceCode = 'NAKHON_RATCHASIMA';
    const strategy = await this.strategyService.findOne(id);
    const entries =
      this.issueCriteriaRegistryService.findAllByStrategyName(strategy.name);

    return {
      strategyId: strategy.id,
      strategyName: strategy.name,
      rulesetVersion:
        entries.length > 0
          ? entries[0].rulesetVersion
          : this.issueCriteriaRegistryService.getCurrentRulesetVersion(
              provinceCode,
            ),
      entries,
      provinceCode: entries.length > 0 ? entries[0].provinceCode : null,
    };
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    this.logger.log(`Request to fetch strategy with ID: ${id}`);
    return this.strategyService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateStrategyDto) {
    this.logger.log(`Request to update strategy with ID: ${id}`);
    return this.strategyService.update(id, dto);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return mode === 'soft'
      ? this.strategyService.softRemove(id, req.user.userId)
      : this.strategyService.remove(id);
  }

  @Patch(':id/restore')
  restore(@Param('id') id: string) {
    return this.strategyService.restore(id);
  }
}
