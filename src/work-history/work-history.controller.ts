import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseUUIDPipe,
  Logger,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
  UseGuards,
  Request,
  Query,
} from '@nestjs/common';
import { WorkHistoryService } from './work-history.service';
import { CreateWorkHistoryDto } from './dto/create-work-history.dto';
import { UpdateWorkHistoryDto, TransferResponsibilityDto } from './dto/update-work-history.dto';
import { CreateWorkHistoryAmphoeResponsibilityDto } from './dto/create-work-history-amphoe-responsibility.dto';
import { UpdateWorkHistoryAmphoeResponsibilityDto } from './dto/update-work-history-amphoe-responsibility.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({
  path: 'work-history',
  version: '1',
})
@UseGuards(JwtAuthGuard)

export class WorkHistoryController {
  private readonly logger = new Logger(WorkHistoryController.name);

  constructor(private readonly workHistoryService: WorkHistoryService) {}

  // ===========================================================================
  // === GET Endpoints =========================================================
  // ===========================================================================

  /**
   * @description Get all work histories
   */
  @Get()
  async findAll(@Query('status') status: string, @Query('role') role: string) {
    this.logger.log(`Fetching all admin work histories${status ? ` with status: ${status}` : ''}${role ? ` and role: ${role}` : ''}`);
    try {
      // Pass both parameters to the service, perhaps as a filter object
      return await this.workHistoryService.findAll( status, role );
    } catch (error) {
      this.logger.error('Error fetching work histories', error.stack);
      throw this.handleException(error);
    }
  }
  /**
   * @description Get all work histories grouped by user
   */
  @Get('/group')
  async findAllGroupedByUser() {
    this.logger.log('Fetching all work histories grouped by user');
    try {
      return await this.workHistoryService.findAllGroupedByUser();
    } catch (error) {
      this.logger.error('Error fetching grouped work histories', error.stack);
      throw this.handleException(error);
    }
  }

  /**
   * @description Get all admin work histories
   */
  @Get('admins')
  async findAllAdminWorkHistories() {
    this.logger.log('Fetching all admin work histories with responsibilities');
    try {
      return await this.workHistoryService.findAllAdminWorkHistories();
    } catch (error) {
      this.logger.error('Error fetching admin work histories', error.stack);
      throw this.handleException(error);
    }
  }


  /**
   * @description Get admin work histories by responsible amphoe
   */
  @Get('admins/by-amphoe/:amphoeId')
  @UseGuards(JwtAuthGuard)
  async findAdminWorkHistoriesByAmphoe(@Param('amphoeId') amphoeId: string) {
    this.logger.log(`Finding admin work histories responsible for amphoe ${amphoeId}`);
    try {
      return await this.workHistoryService.findAdminWorkHistoriesByAmphoe(amphoeId);
    } catch (error) {
      this.logger.error(`Error finding admin work histories for amphoe ${amphoeId}`, error.stack);
      throw this.handleException(error);
    }
  }

  /**
   * @description Get all responsibilities for a specific work history
   */
  @Get('responsibilities/work-history/:workHistoryId')
  @UseGuards(JwtAuthGuard)
  async getResponsibilitiesByWorkHistory(@Param('workHistoryId', ParseUUIDPipe) workHistoryId: string) {
    this.logger.log(`Fetching responsibilities for work history: ${workHistoryId}`);
    try {
      return await this.workHistoryService.getResponsibilitiesByWorkHistory(workHistoryId);
    } catch (error) {
      this.logger.error(`Error fetching responsibilities for work history ${workHistoryId}`, error.stack);
      throw this.handleException(error);
    }
  }

  /**
   * @description Get all responsibilities for a specific amphoe
   */
  @Get('responsibilities/amphoe/:amphoeId')
  @UseGuards(JwtAuthGuard)
  async getResponsibilitiesByAmphoe(@Param('amphoeId', ParseUUIDPipe) amphoeId: string) {
    this.logger.log(`Fetching responsibilities for amphoe: ${amphoeId}`);
    try {
      return await this.workHistoryService.getResponsibilitiesByAmphoe(amphoeId);
    } catch (error) {
      this.logger.error(`Error fetching responsibilities for amphoe ${amphoeId}`, error.stack);
      throw this.handleException(error);
    }
  }

  /**
   * @description Get a single work history by ID
   */
  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Fetching work history with ID: ${id}`);
    try {
      return await this.workHistoryService.findOne(id);
    } catch (error) {
      this.logger.error(`Error fetching work history ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  // ===========================================================================
  // === POST Endpoints ========================================================
  // ===========================================================================

  /**
   * @description Create a new work history
   */
  @Post()
  async create(@Body() dto: CreateWorkHistoryDto) {
    this.logger.log(`Creating new work history for user: ${dto.userId}`);
    try {
      return await this.workHistoryService.create(dto);
    } catch (error) {
      this.logger.error('Error creating work history', error.stack);
      throw this.handleException(error);
    }
  }

  /**
   * @description Add a new responsibility to a work history
   */
  @Post('responsibilities')
  @UseGuards(JwtAuthGuard)
  async addResponsibility(
    @Body() dto: CreateWorkHistoryAmphoeResponsibilityDto,
    @Request() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(`Adding responsibility for work history: ${dto.workHistoryId}`);
    this.logger.log(`Request user ID: ${req.user.userId}`);
    try {
      return await this.workHistoryService.addResponsibility(dto, req.user.userId);
    } catch (error) {
      this.logger.error('Error adding responsibility', error.stack);
      throw this.handleException(error);
    }
  }

  // ===========================================================================
  // === PATCH Endpoints =======================================================
  // ===========================================================================

  /**
   * @description Update a work history by ID
   */
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkHistoryDto,
    @Request() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(`Updating work history with ID: ${id}`);
    try {
      return await this.workHistoryService.update(id, dto , req.user.userId);
    } catch (error) {
      this.logger.error(`Error updating work history ${id}`, error.stack);
      throw this.handleException(error);
    }
  }
  /**
   * @description Transfer a specific responsibility from one admin to another
   */
  @Patch('responsibilities/:id')
  @UseGuards(JwtAuthGuard)
  async transferResponsibility(
    @Param('id', ParseUUIDPipe) responsibilityId: string,
    @Body() dto: TransferResponsibilityDto,
    @Request() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log(`Transferring responsibility ${responsibilityId} to work history ${dto.newWorkHistoryId}`);
    this.logger.log(`Request user ID: ${req.user.userId}`);
    try {
      return await this.workHistoryService.transferResponsibility(responsibilityId, dto.newWorkHistoryId, req.user.userId);
    } catch (error) {
      this.logger.error(`Error transferring responsibility ${responsibilityId}`, error.stack);
      throw this.handleException(error);
    }
  }

  // ===========================================================================
  // === DELETE Endpoints ======================================================
  // ===========================================================================

  /**
   * @description Delete a work history by ID
   */
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.warn(`Removing work history with ID: ${id}`);
    try {
      return await this.workHistoryService.remove(id);
    } catch (error) {
      this.logger.error(`Error removing work history ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  /**
   * @description Delete a responsibility by its ID
   */
  @Delete('responsibilities/:id')
  @UseGuards(JwtAuthGuard)
  async removeResponsibility(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.warn(`Removing responsibility with ID: ${id}`);
    try {
      return await this.workHistoryService.removeResponsibility(id);
    } catch (error) {
      this.logger.error(`Error removing responsibility ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  // ===========================================================================
  // === Private Methods =======================================================
  // ===========================================================================

  private handleException(error: any) {
    if (
      error instanceof NotFoundException ||
      error instanceof BadRequestException
    ) {
      return error;
    }
    return new InternalServerErrorException('Unexpected error occurred');
  }
}