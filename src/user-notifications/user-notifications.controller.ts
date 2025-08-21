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
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';

@Controller({
  version: '1',
  path: 'user-notifications',
})
@UseGuards(JwtAuthGuard)
export class UserNotificationsController {
  constructor(private readonly userNotificationsService: UserNotificationsService) { }

  @Post()
  create(@Body() createUserNotificationDto: CreateUserNotificationDto) {
    return this.userNotificationsService.create(createUserNotificationDto);
  }

  @Get('my-notifications')
  async findMyNotifications(@Request() req: Request & { user: JwtPayloadUser }) {
    // ใช้ userId จาก JWT เพื่อหา workHistory แล้วดึง notifications
    return this.userNotificationsService.findByUserId(req.user.userId);
  }

  @Get('unread-count')
  async getUnreadCount(
    @Request() req: Request & { user: JwtPayloadUser }
  ) {
    const count = await this.userNotificationsService.getUnreadCount(req.user.userId);
    return { unreadCount: count };
  }


  @Patch(':id/read')
  markAsRead(@Param('id', ParseUUIDPipe) id: string) {
    return this.userNotificationsService.markAsRead(id);
  }

} 