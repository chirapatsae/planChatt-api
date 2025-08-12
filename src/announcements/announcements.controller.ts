import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AnnouncementsService } from './announcements.service';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';
import { AnnouncementStatus } from './entities/announcement.entity';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({
  version: '1',
  path: 'announcements',
})
@UseGuards(JwtAuthGuard)
export class AnnouncementsController {
  constructor(private readonly announcementsService: AnnouncementsService) {}

  @Post()
  create(
    @Body() createAnnouncementDto: CreateAnnouncementDto,
    @Request() req: Request & { user: JwtPayloadUser }
  ) {
    return this.announcementsService.create(createAnnouncementDto, req.user.userId);
  }

  @Get()
  findAll() {
    return this.announcementsService.findAll();
  }

  @Get('status/:status')
  findByStatus(@Param('status') status: AnnouncementStatus) {
    return this.announcementsService.findByStatus(status);
  }

  @Get('role/:roleId')
  findByRole(@Param('roleId') roleId: string) {
    return this.announcementsService.findByRole(roleId);
  }

  @Get('work-history/:workHistoryId')
  findByWorkHistory(@Param('workHistoryId') workHistoryId: string) {
    return this.announcementsService.findByWorkHistory(workHistoryId);
  }

  @Get('pending-notifications')
  getPendingNotifications() {
    return this.announcementsService.getPendingNotifications();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.announcementsService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string, 
    @Body() updateAnnouncementDto: UpdateAnnouncementDto,
    @Request() req: Request & { user: JwtPayloadUser }
  ) {
    return this.announcementsService.update(id, updateAnnouncementDto, req.user.userId);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.announcementsService.remove(id);
  }
}
