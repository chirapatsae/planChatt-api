import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { AnnouncementSchedulerService } from './announcement-scheduler.service';

@Processor('announcements')
export class AnnouncementQueueProcessor {
  private readonly logger = new Logger(AnnouncementQueueProcessor.name);

  constructor(
    private readonly announcementSchedulerService: AnnouncementSchedulerService,
  ) {}

  @Process('publish-announcement')
  async handlePublishAnnouncement(job: Job<{ announcementId: string }>) {
    this.logger.log(`🚀 Processing job: ${job.id} for announcement: ${job.data.announcementId}`);
    
    try {
      await this.announcementSchedulerService.publishAnnouncement(job.data.announcementId);
      this.logger.log(`✅ Successfully processed job: ${job.id}`);
    } catch (error) {
      this.logger.error(`❌ Failed to process job: ${job.id}:`, error);
      throw error; // จะทำให้ job fail และ retry
    }
  }
} 