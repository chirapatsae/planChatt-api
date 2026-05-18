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
import { SdgService } from './sdg.service';
import { CreateSdgDto } from './dto/create-sdg.dto';
import { UpdateSdgDto } from './dto/update-sdg.dto';

/**
 * Routes (user-locked 2026-05-18 — `/v1/strategic-graph/...` namespace):
 *   GET    /v1/strategic-graph/sdgs
 *   GET    /v1/strategic-graph/sdgs/:id
 *   POST   /v1/strategic-graph/sdgs            — admin
 *   PATCH  /v1/strategic-graph/sdgs/:id        — admin
 *   DELETE /v1/strategic-graph/sdgs/:id        — admin
 *   POST   /v1/strategic-graph/sdgs/:id/restore — admin
 */
@Controller({
  path: 'strategic-graph/sdgs',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class SdgController {
  private readonly logger = new Logger(SdgController.name);

  constructor(private readonly service: SdgService) {}

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
    @Body() dto: CreateSdgDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.create(dto, req.user.userId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSdgDto,
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
