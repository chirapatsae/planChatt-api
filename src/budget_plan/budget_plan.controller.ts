import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { BudgetPlanService } from './budget_plan.service';
import { CreateBudgetPlanDto } from './dto/create-budget_plan.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { Request } from 'express';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({ path: 'budget-plan', version: '1' })
@UseGuards(JwtAuthGuard)
export class BudgetPlanController {
  private readonly logger = new Logger(BudgetPlanController.name);

  constructor(private readonly budgetPlanService: BudgetPlanService) {}

  @Post()
  async create(@Body() createBudgetPlanDto: CreateBudgetPlanDto, @Req() req: Request & { user: JwtPayloadUser }) {
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
}
