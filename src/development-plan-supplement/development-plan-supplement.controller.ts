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
import { DevelopmentPlanSupplementService } from './development-plan-supplement.service';
import { CreateDevelopmentPlanSupplementDto } from './dto/create-development-plan-supplement.dto';
import { UpdateDevelopmentPlanSupplementDto } from './dto/update-development-plan-supplement.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { Request } from 'express';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { DeleteDevelopmentPlanDto } from 'src/development-plan/dto/delete-development-plan.dto';
import { UpdateDevelopmentPlanSupplementOpenStateDto } from './dto/update-development-plan-supplement-open-state.dto';

@Controller({ path: 'development-plan-supplement', version: '1' })
@UseGuards(JwtAuthGuard)
export class DevelopmentPlanSupplementController {
  private readonly logger = new Logger(DevelopmentPlanSupplementController.name);

  constructor(
    private readonly developmentPlanSupplementService: DevelopmentPlanSupplementService,
  ) {}

  @Post()
  async create(
    @Body() createDto: CreateDevelopmentPlanSupplementDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Creating development plan supplement by user ${userId}`);
    return this.developmentPlanSupplementService.create(createDto, userId);
  }

  @Get()
  async findAll(@Query('developmentPlanId') developmentPlanId?: string) {
    if (developmentPlanId) {
      return this.developmentPlanSupplementService.findByDevelopmentPlan(developmentPlanId);
    }
    this.logger.log('Fetching all development plan supplements');
    return this.developmentPlanSupplementService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    this.logger.log(`Fetching development plan supplement with id: ${id}`);
    return this.developmentPlanSupplementService.findOne(id);
  }
  

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() updateDto: UpdateDevelopmentPlanSupplementDto,
  ) {
    this.logger.log(`Updating development plan supplement with id: ${id}`);
    return this.developmentPlanSupplementService.update(id, updateDto);
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Body() deleteDto: DeleteDevelopmentPlanDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Removing development plan supplement with id: ${id} by user ${userId}`);
    return this.developmentPlanSupplementService.softRemove(id, userId, deleteDto.citizenIdSuffix);
  }

  @Patch(':id/open-state')
  async updateOpenState(
    @Param('id') id: string,
    @Body() dto: UpdateDevelopmentPlanSupplementOpenStateDto,
  ) {
    this.logger.log(`Updating open state for development plan supplement with id: ${id}`);
    return this.developmentPlanSupplementService.updateOpenState(id, dto.isOpen);
  }
}

