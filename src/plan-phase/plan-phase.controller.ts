import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  Req,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { PlanPhaseService } from './plan-phase.service';
import { CreatePlanPhaseDto } from './dto/create-plan-phase.dto';
import { UpdatePlanPhaseDto } from './dto/update-plan-phase.dto';
import { UpdatePlanPhaseOpenStateDto } from './dto/update-plan-phase-open-state.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { Request } from 'express';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({ path: 'plan-phase', version: '1' })
@UseGuards(JwtAuthGuard)
export class PlanPhaseController {
  private readonly logger = new Logger(PlanPhaseController.name);

  constructor(private readonly planPhaseService: PlanPhaseService) {}

  @Post()
  create(
    @Body() createPlanPhaseDto: CreatePlanPhaseDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Creating plan phase by user ${userId}`);
    return this.planPhaseService.create(createPlanPhaseDto, userId);
  }

  @Get()
  findAll(@Query('developmentPlanId') developmentPlanId?: string) {
    this.logger.log('Fetching all plan phases');
    return this.planPhaseService.findAll(developmentPlanId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    this.logger.log(`Fetching plan phase with id: ${id}`);
    return this.planPhaseService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updatePlanPhaseDto: UpdatePlanPhaseDto,
  ) {
    this.logger.log(`Updating plan phase with id: ${id}`);
    return this.planPhaseService.update(id, updatePlanPhaseDto);
  }

  @Patch(':id/open-state')
  updateOpenState(
    @Param('id') id: string,
    @Body() openStateDto: UpdatePlanPhaseOpenStateDto,
  ) {
    this.logger.log(`Updating open state for plan phase with id: ${id}`);
    return this.planPhaseService.updateOpenState(id, openStateDto.isOpen);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    this.logger.log(`Removing plan phase with id: ${id}`);
    return this.planPhaseService.remove(id);
  }
}