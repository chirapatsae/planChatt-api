import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
  Logger,
  Query,
} from '@nestjs/common';
import { DevelopmentPlanRevisionService } from './development-plan-revision.service';
import { CreateDevelopmentPlanRevisionDto } from './dto/create-development-plan-revision.dto';
import { UpdateDevelopmentPlanRevisionDto } from './dto/update-development-plan-revision.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { Request } from 'express';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({ path: 'development-plan-revision', version: '1' })
@UseGuards(JwtAuthGuard)
export class DevelopmentPlanRevisionController {
  private readonly logger = new Logger(DevelopmentPlanRevisionController.name);

  constructor(
    private readonly developmentPlanRevisionService: DevelopmentPlanRevisionService,
  ) {}

  @Post()
  async create(
    @Body() createDto: CreateDevelopmentPlanRevisionDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Creating development plan revision by user ${userId}`);
    return this.developmentPlanRevisionService.create(createDto, userId);
  }

  @Get()
  async findAll(@Query('budgetPlanId') budgetPlanId?: string) {
    if (budgetPlanId) {
      return this.developmentPlanRevisionService.findByBudgetPlan(budgetPlanId);
    }
    this.logger.log('Fetching all development plan revisions');
    return this.developmentPlanRevisionService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    this.logger.log(`Fetching development plan revision with id: ${id}`);
    return this.developmentPlanRevisionService.findOne(id);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() updateDto: UpdateDevelopmentPlanRevisionDto,
  ) {
    this.logger.log(`Updating development plan revision with id: ${id}`);
    return this.developmentPlanRevisionService.update(id, updateDto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    this.logger.log(`Removing development plan revision with id: ${id}`);
    return this.developmentPlanRevisionService.remove(id);
  }
}
