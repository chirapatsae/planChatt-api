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
import { NationalStrategyService } from './national-strategy.service';
import { CreateNationalStrategyDto } from './dto/create-national-strategy.dto';
import { UpdateNationalStrategyDto } from './dto/update-national-strategy.dto';

/**
 * Routes (user-locked 2026-05-18 — `/v1/strategic-graph/...` namespace):
 *   GET    /v1/strategic-graph/national-strategies            — list (any auth user)
 *   GET    /v1/strategic-graph/national-strategies/:id        — read one
 *   POST   /v1/strategic-graph/national-strategies            — admin write
 *   PATCH  /v1/strategic-graph/national-strategies/:id        — admin update
 *   DELETE /v1/strategic-graph/national-strategies/:id        — admin soft delete
 *   POST   /v1/strategic-graph/national-strategies/:id/restore — admin restore
 *
 * Role enforcement lives in the service per project convention
 * (mirrors DevelopmentIssueService.assertStaffLead). The controller
 * only enforces JwtAuthGuard.
 */
@Controller({
  path: 'strategic-graph/national-strategies',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class NationalStrategyController {
  private readonly logger = new Logger(NationalStrategyController.name);

  constructor(private readonly service: NationalStrategyService) {}

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
    @Body() dto: CreateNationalStrategyDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.create(dto, req.user.userId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateNationalStrategyDto,
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
