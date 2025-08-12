import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { NotificationLogsService } from './notification-logs.service';
import { CreateNotificationLogDto } from './dto/create-notification-log.dto';
import { UpdateNotificationLogDto } from './dto/update-notification-log.dto';
import { NotificationLogStatus } from './entities/notification-log.entity';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  version: '1',
  path: 'notification-logs',
})
@UseGuards(JwtAuthGuard)
export class NotificationLogsController {
  constructor(private readonly notificationLogsService: NotificationLogsService) {}

  @Post()
  create(@Body() createNotificationLogDto: CreateNotificationLogDto) {
    return this.notificationLogsService.create(createNotificationLogDto);
  }

  @Get()
  findAll() {
    return this.notificationLogsService.findAll();
  }

  @Get('announcement/:announcementId')
  findByAnnouncement(@Param('announcementId') announcementId: string) {
    return this.notificationLogsService.findByAnnouncement(announcementId);
  }

  @Get('role/:roleId')
  findByRole(@Param('roleId') roleId: string) {
    return this.notificationLogsService.findByRole(roleId);
  }

  @Get('status/:status')
  findByStatus(@Param('status') status: NotificationLogStatus) {
    return this.notificationLogsService.findByStatus(status);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.notificationLogsService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateNotificationLogDto: UpdateNotificationLogDto) {
    return this.notificationLogsService.update(id, updateNotificationLogDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.notificationLogsService.remove(id);
  }
}
