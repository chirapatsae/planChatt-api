import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { DevelopmentIssueService } from './development-issue.service';
import { CreateDevelopmentIssueDto } from './dto/create-development-issue.dto';
import { UpdateDevelopmentIssueDto } from './dto/update-development-issue.dto';
import { CopyDevelopmentIssuesDto } from './dto/copy-development-issues.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { IssueCriteriaRegistryService } from 'src/ai/criteria/issue-criteria-registry.service';
import {
  IssueRuleEntry,
  ProvinceCode,
} from 'src/ai/criteria/issue-criteria.types';

/**
 * DevelopmentIssueController — CLAUDE.md §16.6
 *
 * Plan-scoped CRUD endpoints for `DevelopmentIssue`. Role enforcement
 * and §15 book lock enforcement live in the service (not the
 * controller) so that every mutation path — including any future
 * admin-script path — runs through the same guards.
 */
@Controller({ path: 'development-issue', version: '1' })
@UseGuards(JwtAuthGuard)
export class DevelopmentIssueController {
  private readonly logger = new Logger(DevelopmentIssueController.name);

  constructor(
    private readonly developmentIssueService: DevelopmentIssueService,
    private readonly issueCriteriaRegistryService: IssueCriteriaRegistryService,
  ) {}

  @Post()
  async create(
    @Body() dto: CreateDevelopmentIssueDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Creating development issue for plan ${dto.developmentPlanId} by user ${userId}`,
    );
    return this.developmentIssueService.create(dto, userId);
  }

  @Get()
  async findAllByPlan(@Query('planId') planId: string) {
    this.logger.log(`Listing development issues for plan ${planId}`);
    return this.developmentIssueService.findAllByPlan(planId);
  }

  @Post('copy-from-plan')
  async copyFromPlan(
    @Body() dto: CopyDevelopmentIssuesDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Copying development issues from plan ${dto.sourcePlanId} to plan ${dto.targetPlanId} by user ${userId}`,
    );
    return this.developmentIssueService.copyFromPlan(
      dto.targetPlanId,
      dto.sourcePlanId,
      userId,
      dto.issueIds,
    );
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateDevelopmentIssueDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Updating development issue ${id} by user ${userId}`);
    return this.developmentIssueService.update(id, dto, userId);
  }

  @Delete(':id')
  async softRemove(
    @Param('id') id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Soft-removing development issue ${id} by user ${userId}`);
    return this.developmentIssueService.softRemove(id, userId);
  }

  /**
   * GET /v1/development-issue/:id/criteria — Wave 24 N1.
   *
   * Returns the issue-criteria registry entry for a plan-scoped
   * `DevelopmentIssue`, or `entry: null` when no entry matches (FE
   * hides the panel). HTTP 404 when the id is unknown.
   *
   * Auth: any authenticated user can call — advisory data, no
   * role gate (architecture §5.1 / CLAUDE.md §17.2).
   *
   * Province resolution: Wave 24 hardcodes `NAKHON_RATCHASIMA`. Wave 25
   * will derive the province from the caller's current WorkHistory.
   *
   * Response is safe to cache per-user for 5 minutes — rules are
   * static in-code constants.
   */
  @Get(':id/criteria')
  @Header('Cache-Control', 'private, max-age=300')
  async findCriteriaByIssueId(
    @Param('id') id: string,
  ): Promise<{
    issueId: string;
    issueName: string;
    rulesetVersion: string | null;
    entry: IssueRuleEntry | null;
    provinceCode: ProvinceCode | null;
  }> {
    const provinceCode: ProvinceCode = 'NAKHON_RATCHASIMA';
    const { issue, entry } =
      await this.issueCriteriaRegistryService.findByIssueId(id, provinceCode);

    if (!issue) {
      // The issue itself must exist for any authenticated user to get
      // criteria; otherwise surface 404 so FE can distinguish
      // "unknown id" from "known issue, no rule match" (entry: null).
      throw new NotFoundException(`DevelopmentIssue not found: ${id}`);
    }

    return {
      issueId: issue.id,
      issueName: issue.name,
      rulesetVersion: entry
        ? entry.rulesetVersion
        : this.issueCriteriaRegistryService.getCurrentRulesetVersion(
            provinceCode,
          ),
      entry,
      provinceCode: entry ? entry.provinceCode : null,
    };
  }
}
