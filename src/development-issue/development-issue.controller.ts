import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
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
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

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
}
