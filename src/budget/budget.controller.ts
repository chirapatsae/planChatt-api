import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';
import { BudgetService } from './budget.service';

@Controller({
  path: 'budgets',
  version: '1',
})
export class BudgetController {
  private readonly logger = new Logger(BudgetController.name);

  constructor(private readonly budgetService: BudgetService) {}

  @Post()
  async create(@Body() dto: CreateBudgetDto) {
    this.logger.log('Creating budget');
    try {
      return await this.budgetService.create(dto);
    } catch (error) {
      this.logger.error('Error creating budget', error.stack);
      throw this.handleError(error);
    }
  }

  @Get()
  async findAll() {
    try {
      return await this.budgetService.findAll();
    } catch (error) {
      this.logger.error('Error fetching all budgets', error.stack);
      throw this.handleError(error);
    }
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: string) {
    try {
      return await this.budgetService.findOne(id);
    } catch (error) {
      this.logger.error(`Error fetching budget id=${id}`, error.stack);
      throw this.handleError(error);
    }
  }

  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: string,
    @Body() dto: UpdateBudgetDto,
  ) {
    this.logger.log(`Updating budget id=${id}`);
    try {
      return await this.budgetService.update(id, dto);
    } catch (error) {
      this.logger.error(`Error updating budget id=${id}`, error.stack);
      throw this.handleError(error);
    }
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: string) {
    this.logger.warn(`Removing budget id=${id}`);
    try {
      return await this.budgetService.remove(id);
    } catch (error) {
      this.logger.error(`Error removing budget id=${id}`, error.stack);
      throw this.handleError(error);
    }
  }

  private handleError(error: any) {
    if (error instanceof BadRequestException) return error;
    return new InternalServerErrorException('Unexpected error occurred');
  }
}
