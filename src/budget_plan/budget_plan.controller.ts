import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
  Logger,
  Patch,
  Delete,
  Query,
} from '@nestjs/common';
import { BudgetPlanService } from './budget_plan.service';
import { CreateBudgetPlanDto } from './dto/create-budget_plan.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { Request } from 'express';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { UpdateBudgetPlanDto } from './dto/update-budget_plan.dto';

@Controller({ path: 'budget-plan', version: '1' })
@UseGuards(JwtAuthGuard)
export class BudgetPlanController {
  private readonly logger = new Logger(BudgetPlanController.name);

  constructor(private readonly budgetPlanService: BudgetPlanService) {}

  @Post()
  async create(
    @Body() createBudgetPlanDto: CreateBudgetPlanDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Creating budget plan by user ${userId}`);
    return this.budgetPlanService.create(createBudgetPlanDto, userId);
  }

  @Get()
  async findAll() {
    this.logger.log('Fetching all budget plans');
    return this.budgetPlanService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    this.logger.log(`Fetching budget plan with id: ${id}`);
    return this.budgetPlanService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateBudgetPlanDto: UpdateBudgetPlanDto,
  ) {
    return this.budgetPlanService.update(id, updateBudgetPlanDto);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    return mode === 'soft'
      ? this.budgetPlanService.softRemove(id)
      : this.budgetPlanService.remove(id);
  }

  @Patch(':id/restore')
  restore(@Param('id') id: string) {
    return this.budgetPlanService.restore(id);
  }
}
