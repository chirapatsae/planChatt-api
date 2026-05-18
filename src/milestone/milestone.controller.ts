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
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { MilestoneService } from './milestone.service';
import { CreateMilestoneDto } from './dto/create-milestone.dto';
import { UpdateMilestoneDto } from './dto/update-milestone.dto';

/**
 * Routes (user-locked 2026-05-18 — `/v1/strategic-graph/...` namespace):
 *   GET    /v1/strategic-graph/milestones
 *   GET    /v1/strategic-graph/milestones/:id
 *   POST   /v1/strategic-graph/milestones            — admin
 *   PATCH  /v1/strategic-graph/milestones/:id        — admin
 *   DELETE /v1/strategic-graph/milestones/:id        — admin
 *   POST   /v1/strategic-graph/milestones/:id/restore — admin
 */
@Controller({
  path: 'strategic-graph/milestones',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class MilestoneController {
  private readonly logger = new Logger(MilestoneController.name);

  constructor(private readonly service: MilestoneService) {}

  @Get()
  findAll(@Query('activeOnly') activeOnly?: string) {
    return this.service.findAll(activeOnly === 'true');
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  create(
    @Body() dto: CreateMilestoneDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.create(dto, req.user.userId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateMilestoneDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.update(id, dto, req.user.userId);
  }

  @Delete(':id')
  softRemove(
    @Param('id') id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.softRemove(id, req.user.userId);
  }

  @Post(':id/restore')
  restore(
    @Param('id') id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.restore(id, req.user.userId);
  }
}
