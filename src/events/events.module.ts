import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { Event } from './entities/event.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { AttachmentEventModule } from 'src/attachment-event/attachment-event.module';
import { AnnouncementsModule } from 'src/announcements/announcements.module';
import { RolesModule } from 'src/roles/roles.module';
import { UsersModule } from 'src/users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Event, WorkHistory]),
    AttachmentEventModule,
    AnnouncementsModule,
    RolesModule,
    // W89B — UsersService.decryptUserPii used in mapToResponseDto.
    UsersModule,
  ],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
