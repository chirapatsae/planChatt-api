import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
  Query,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';
import { BudgetService } from './budget.service';
import { IsUUID } from 'class-validator';

@Controller({
  path: 'budgets',
  version: '1',
})
export class BudgetController {
  constructor(private readonly budgetService: BudgetService) { }

  @Post()
  create(@Body() dto: CreateBudgetDto) {
    return this.budgetService.create(dto);
  }

  @Get()
  findAll(
    @Query('groupId', new ParseUUIDPipe({ optional: true })) groupId?: string,
  ) {
    // Now you pass the groupId to the service method
    return this.budgetService.findAll(groupId);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.budgetService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBudgetDto) {
    return this.budgetService.update(id, dto);
  }

  @Put('project-group/:projectGroupId')
  async updateProjectGroupBudgets(
    @Param('projectGroupId') projectGroupId: string,
    @Body() body: { budgets: { year: number, quantity: number }[] }
  ) {
    return this.budgetService.replaceBudgets(projectGroupId, body.budgets);
  }


  @Delete(':id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    return mode === 'soft'
      ? this.budgetService.softRemove(id)
      : this.budgetService.remove(id);
  }

  @Patch(':id/restore')
  restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.budgetService.restore(id);
  }
}
