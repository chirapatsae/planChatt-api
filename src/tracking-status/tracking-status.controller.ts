import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Logger,
  UseGuards,
  ParseUUIDPipe,
  Query,
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
  create(
    @Body() dto: CreateTrackingStatusDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log('Request to create tracking status');
    return this.trackingStatusService.create(dto, req.user.userId);
  }

  @Post('create-by-revised-project-group')
  createByRevisedProjectGroup(
    @Body() dto: CreateTrackingStatusDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    this.logger.log('Request to create tracking status by revised project group');
    return this.trackingStatusService.createByRevisedProjectGroup(dto, req.user.userId);
  }

  @Post('bulk')
  createMany(
    @Body() dtos: CreateTrackingStatusDto[],
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.trackingStatusService.createMany(dtos, req.user.userId);
  }

  @Post('bulk/revised-project-group')
  createManyRevisedProjectGroup(
    @Body() dtos: CreateTrackingStatusDto[],
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.trackingStatusService.createManyRevisedProjectGroup(dtos, req.user.userId);
  }


  @Get()
  findAll() {
    this.logger.log('Request to fetch all tracking statuses');
    return this.trackingStatusService.findAll();
  }

  @Post('rollback/:projectGroupId')
  rollbackStatus(
    @Param('projectGroupId', ParseUUIDPipe) projectGroupId: string,
    @Body() body: {
      isResponsibleClear?: boolean
      isBookedClear?: boolean
    },
  ) {
    // รองรับทั้ง shouldClearResponsible (จากหน้าบ้าน) และ isResponsibleClear (backward compatibility)
    this.logger.log(`Request to rollback tracking status for project group: ${projectGroupId}`)
    return this.trackingStatusService.rollbackStatus(projectGroupId, body.isResponsibleClear , body.isBookedClear);
  }


  @Post('rollback/revised-project-group/:revisionProjectGroupId')
  rollbackStatusRevisedProjectGroup(
    @Param('revisionProjectGroupId', ParseUUIDPipe) revisionProjectGroupId: string,
  ) {
    this.logger.log(`Request to rollback tracking status for project group: ${revisionProjectGroupId}`);
    return this.trackingStatusService.rollbackRevisionProjectGroupStatus(revisionProjectGroupId);
  }


  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Request to fetch tracking status with ID: ${id}`);
    return this.trackingStatusService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTrackingStatusDto,
  ) {
    this.logger.log(`Request to update tracking status with ID: ${id}`);
    return this.trackingStatusService.update(id, dto);
  }

  @Delete(':id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.trackingStatusService.softRemove(id);
  }

  @Patch(':id/restore')
  restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.trackingStatusService.restore(id);
  }
}
