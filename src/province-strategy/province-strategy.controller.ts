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
import { ProvinceStrategyService } from './province-strategy.service';
import { CreateProvinceStrategyDto } from './dto/create-province-strategy.dto';
import { UpdateProvinceStrategyDto } from './dto/update-province-strategy.dto';

/**
 * Routes (user-locked 2026-05-18 — `/v1/strategic-graph/...` namespace):
 *   GET    /v1/strategic-graph/province-strategies
 *   GET    /v1/strategic-graph/province-strategies/:id
 *   POST   /v1/strategic-graph/province-strategies            — admin
 *   PATCH  /v1/strategic-graph/province-strategies/:id        — admin
 *   DELETE /v1/strategic-graph/province-strategies/:id        — admin
 *   POST   /v1/strategic-graph/province-strategies/:id/restore — admin
 */
@Controller({
  path: 'strategic-graph/province-strategies',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class ProvinceStrategyController {
  private readonly logger = new Logger(ProvinceStrategyController.name);

  constructor(private readonly service: ProvinceStrategyService) {}

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
    @Body() dto: CreateProvinceStrategyDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.service.create(dto, req.user.userId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProvinceStrategyDto,
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
