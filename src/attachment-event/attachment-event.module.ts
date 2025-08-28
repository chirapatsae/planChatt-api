import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttachmentEventService } from './attachment-event.service';
import { AttachmentEventController } from './attachment-event.controller';
import { AttachmentEvent } from './entities/attachment-event.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AttachmentEvent])],
  controllers: [AttachmentEventController],
  providers: [AttachmentEventService],
  exports: [AttachmentEventService],
})
export class AttachmentEventModule {}
