import { Module } from '@nestjs/common';
import { WorkHistoryService } from './work-history.service';
import { WorkHistoryLookupService } from './work-history-lookup.service';
import { WorkHistoryController } from './work-history.controller';
import { WorkHistory } from './entities/work-history.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from 'src/users/entities/user.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { Role } from 'src/roles/entities/role.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { Position } from 'src/positions/entities/position.entity';
import { WorkStatus } from 'src/work-status/entities/work-status.entity';
import { WebsocketModule } from 'src/websocket/websocket.module';
import { AnnouncementsModule } from 'src/announcements/announcements.module';
import { UsersModule } from 'src/users/users.module';
import { RolesGuard } from 'src/auth/roles.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorkHistory,
      User,
      LocalAdministrativeOrganization,
      Amphoe,
      Role,
      GovernmentAgency,
      Position,
      WorkStatus,
    ]),
    WebsocketModule,
    AnnouncementsModule,
    UsersModule,
  ],
  controllers: [WorkHistoryController],
  providers: [WorkHistoryService, WorkHistoryLookupService, RolesGuard],
  exports: [WorkHistoryService, WorkHistoryLookupService],
})
export class WorkHistoryModule {}
