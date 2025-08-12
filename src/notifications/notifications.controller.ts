import { Controller, Post, Param, UseGuards, Get } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  version: '1',
  path: 'notifications',
})
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('send/:announcementId')
  async sendImmediateNotification(@Param('announcementId') announcementId: string) {
    return this.notificationsService.sendImmediateNotification(announcementId);
  }

  @Get('status')
  async getStatus() {
    return { 
      message: 'Notification service is running',
      timestamp: new Date().toISOString()
    };
  }
} 