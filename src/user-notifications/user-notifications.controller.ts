import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Delete,
  UseGuards,
  Request,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { UserNotificationsService } from './user-notifications.service';
import { CreateUserNotificationDto } from './dto/create-user-notification.dto';
import { UpdateUserNotificationDto } from './dto/update-user-notification.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({
  version: '1',
  path: 'user-notifications',
})
@UseGuards(JwtAuthGuard)
export class UserNotificationsController {
  constructor(private readonly userNotificationsService: UserNotificationsService) {}

  @Post()
  create(@Body() createUserNotificationDto: CreateUserNotificationDto) {
    return this.userNotificationsService.create(createUserNotificationDto);
  }

  @Get()
  findAll() {
    return this.userNotificationsService.findAll();
  }

  @Get('my-notifications')
  async findMyNotifications(@Request() req: Request & { user: JwtPayloadUser }) {
    // ใช้ userId จาก JWT เพื่อหา workHistory แล้วดึง notifications
    return this.userNotificationsService.findByUserId(req.user.userId);
  }

  @Get('unread-count')
  async getUnreadCount(
    @Request() req:Request & { user: JwtPayloadUser }
  ) {
    const count = await this.userNotificationsService.getUnreadCount(req.user.userId);
    return { unreadCount: count };
  }

  @Get('by-work-history/:workHistoryId')
  findByWorkHistory(@Param('workHistoryId', ParseUUIDPipe) workHistoryId: string) {
    return this.userNotificationsService.findByWorkHistory(workHistoryId);
  }

  @Get('by-announcement/:announcementId')
  findByAnnouncement(@Param('announcementId', ParseUUIDPipe) announcementId: string) {
    return this.userNotificationsService.findByAnnouncement(announcementId);
  }

  @Get('by-status/:workHistoryId/:status')
  findByStatus(
    @Param('workHistoryId', ParseUUIDPipe) workHistoryId: string,
    @Param('status') status: string,
  ) {
    return this.userNotificationsService.findByStatus(workHistoryId, status as any);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.userNotificationsService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserNotificationDto: UpdateUserNotificationDto,
  ) {
    return this.userNotificationsService.update(id, updateUserNotificationDto);
  }

  @Patch(':id/read')
  markAsRead(@Param('id', ParseUUIDPipe) id: string) {
    return this.userNotificationsService.markAsRead(id);
  }

  @Patch('bulk/read')
  markAsReadBulk(@Body() body: { ids: string[] }) {
    // Validate that all IDs are valid UUIDs
    if (!body.ids.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
      throw new Error('All IDs must be valid UUIDs');
    }
    return this.userNotificationsService.markAsReadBulk(body.ids);
  }

  @Patch('work-history/:workHistoryId/read-all')
  markAllAsRead(@Param('workHistoryId', ParseUUIDPipe) workHistoryId: string) {
    return this.userNotificationsService.markAllAsRead(workHistoryId);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.userNotificationsService.remove(id);
  }
} 