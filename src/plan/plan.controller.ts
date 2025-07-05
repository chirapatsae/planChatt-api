import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Logger,
  NotFoundException,
  InternalServerErrorException,
  UseGuards,
} from '@nestjs/common';
import { PlanService } from './plan.service';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  path: 'plans',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class PlanController {
  private readonly logger = new Logger(PlanController.name);

  constructor(private readonly planService: PlanService) { }


  @Get()
  async findAll() {
    try {
      return await this.planService.findAll();
    } catch (error) {
      this.logger.error('Error fetching all plans', error.stack);
      throw new InternalServerErrorException('Failed to fetch plans');
    }
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    try {
      return await this.planService.findOne(id);
    } catch (error) {
      this.logger.error(`Error fetching plan ${id}`, error.stack);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException('Failed to fetch plan');
    }
  }

  @Get('/from-tactic/:tacticId')
  async findPlansFromTactic(@Param('tacticId') tacticId: string) {
    try {
    return this.planService.findPlansByTacticId(tacticId);
      
    } catch (error) {
      this.logger.error(`Error fetching plan from tactic ${tacticId}`, error.stack);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException('Failed to fetch plan');
    }
  }
}
