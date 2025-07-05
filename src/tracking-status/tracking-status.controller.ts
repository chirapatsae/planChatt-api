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
  Req,
} from '@nestjs/common';
import { TrackingStatusService } from './tracking-status.service';
import { CreateTrackingStatusDto } from './dto/create-tracking-status.dto';
import { UpdateTrackingStatusDto } from './dto/update-tracking-status.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({
  path: 'tracking-status',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class TrackingStatusController {
  private readonly logger = new Logger(TrackingStatusController.name);

  constructor(private readonly trackingStatusService: TrackingStatusService) { }

  @Post()
  async create(@Body() dto: CreateTrackingStatusDto , @Req() req: Request & { user: JwtPayloadUser } ) {
    this.logger.log('Creating tracking status...');
    try {
      return await this.trackingStatusService.create(dto ,req.user.userId);
    } catch (error) {
      this.logger.error('Error creating tracking status', error.stack);
      throw this.handleException(error);
    }
  }

  @Get()
  async findAll() {
    this.logger.log('Fetching all tracking statuses...');
    try {
      return await this.trackingStatusService.findAll();
    } catch (error) {
      this.logger.error('Error fetching tracking statuses', error.stack);
      throw this.handleException(error);
    }
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Fetching tracking status ${id}`);
    try {
      return await this.trackingStatusService.findOne(id);
    } catch (error) {
      this.logger.error(`Error fetching tracking status ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTrackingStatusDto,
  ) {
    this.logger.log(`Updating tracking status ${id}`);
    try {
      return await this.trackingStatusService.update(id, dto);
    } catch (error) {
      this.logger.error(`Error updating tracking status ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Delete(':id/soft-remove')
  async softRemove(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.warn(`Removing tracking status ${id}`);
    try {
      return await this.trackingStatusService.softRemove(id);
    } catch (error) {
      this.logger.error(`Error removing tracking status ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Patch(':id/restore')
  async restore(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.warn(`Restoring tracking status ${id}`);
    try {
      return await this.trackingStatusService.restore(id);
    } catch (error) {
      this.logger.error(`Error restoring tracking status ${id}`, error.stack);
      throw this.handleException(error);
    }
  }
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
