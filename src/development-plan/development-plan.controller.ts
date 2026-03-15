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
  Res,
  ForbiddenException,
} from '@nestjs/common';
import { DevelopmentPlanService } from './development-plan.service';
import { CreateDevelopmentPlanDto } from './dto/create-development-plan.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { Request, Response } from 'express';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { UpdateDevelopmentPlanDto } from './dto/update-development-plan.dto';
import { CreateDevelopmentPlanWithPhaseDto } from './dto/create-development-plan-with-phase.dto';
import { UpdateDevelopmentPlanWithPhasesDto } from './dto/update-development-plan-with-phase.dto';
import { UpdateDevelopmentPlanLatestStatusDto } from './dto/update-development-plan-latest-status.dto';
import { DeleteDevelopmentPlanDto } from './dto/delete-development-plan.dto';

@Controller({ path: 'development-plan', version: '1' })
@UseGuards(JwtAuthGuard)
export class DevelopmentPlanController {
  private readonly logger = new Logger(DevelopmentPlanController.name);

  constructor(private readonly developmentPlanService: DevelopmentPlanService) {}

  @Post()
  async create(
    @Body() createDevelopmentPlanDto: CreateDevelopmentPlanDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Creating development plan by user ${userId}`);
    return this.developmentPlanService.create(createDevelopmentPlanDto, userId);
  }

  @Post('with-phase')
  async createWithPhase(
    @Body() createDevelopmentPlanWithPhaseDto: CreateDevelopmentPlanWithPhaseDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Creating development plan with initial phase by user ${userId}`);
    return this.developmentPlanService.createWithPhase(createDevelopmentPlanWithPhaseDto, userId);
  }

  @Get()
  async findAll() {
    this.logger.log('Fetching all development plans');
    return this.developmentPlanService.findAll();
  }

  @Get('all/unordered')
  async findAllUnordered() {
    this.logger.log('Fetching all development plans (unordered)');
    return this.developmentPlanService.findAllUnordered();
  }

  @Get('status/count')
  async getStatusCount() {
    this.logger.log('Fetching development plan status counts');
    return this.developmentPlanService.getCurrentPlanStatus();
  }

  @Post(':id/book')
  async generateApprovedBookForPlan(
    @Param('id') id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Generate approved book for development plan ${id} by user ${userId}`);
    return this.developmentPlanService.generateApprovedBookForPlan(id, userId);
  }

  @Post(':id/book-preview')
  async previewApprovedBookForPlan(
    @Param('id') id: string,
    @Req() req: Request & { user: JwtPayloadUser },
    @Res() res: Response,
  ) {
    const userId = req.user?.userId;
    this.logger.log(
      `Generate approved book PREVIEW for development plan ${id} by user ${userId}`,
    );
    const pdfBuffer =
      await this.developmentPlanService.generateApprovedBookPreviewForPlan(
        id,
        userId,
      );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename=development-plan-approved-preview.pdf',
    });

    res.end(pdfBuffer);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    this.logger.log(`Fetching development plan with id: ${id}`);
    return this.developmentPlanService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateDevelopmentPlanDto: UpdateDevelopmentPlanDto,
  ) {
    return this.developmentPlanService.update(id, updateDevelopmentPlanDto);
  }

  @Patch(':id/latest-status')
  async updateLatestStatus(
    @Param('id') id: string,
    @Body() updateDevelopmentPlanLatestStatusDto: UpdateDevelopmentPlanLatestStatusDto,
  ) {
    this.logger.log(`Updating isLatest for development plan ${id}`);
    return this.developmentPlanService.updateLatestStatus(id, updateDevelopmentPlanLatestStatusDto);
  }

  @Patch(':id/with-phases')
  async updateWithPhases(
    @Param('id') id: string,
    @Body() updateDevelopmentPlanWithPhasesDto: UpdateDevelopmentPlanWithPhasesDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Updating development plan with phases ${id} by user ${userId}`);
    return this.developmentPlanService.updateWithPhases(
      id,
      updateDevelopmentPlanWithPhasesDto,
      userId,
    );
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Body() deleteDevelopmentPlanDto: DeleteDevelopmentPlanDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Deleting development plan ${id} by user ${userId}`);
    return this.developmentPlanService.softRemove(id, userId, deleteDevelopmentPlanDto.citizenIdSuffix);
  }

  @Post('check-citizen-suffix')
  async checkCitizenSuffix(
    @Body() deleteDevelopmentPlanDto: DeleteDevelopmentPlanDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;


    this.logger.log(`Checking citizen ID suffix for user ${userId}`);
    return this.developmentPlanService.checkCitizenIdSuffix(
      userId,
      deleteDevelopmentPlanDto.citizenIdSuffix,
    );
  }

  @Patch(':id/restore')
  restore(@Param('id') id: string) {
    return this.developmentPlanService.restore(id);
  }

  @Post(':id/rollback-book')
  async rollbackBook(
    @Param('id') id: string,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    const userId = req.user?.userId;
    this.logger.log(`Rollback book for development plan ${id} by user ${userId}`);
    return this.developmentPlanService.rollbackBook(id, userId);
  }
}

