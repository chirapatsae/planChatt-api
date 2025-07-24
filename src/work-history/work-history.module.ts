import { Module } from '@nestjs/common';
import { WorkHistoryService } from './work-history.service';
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
  ],
  controllers: [WorkHistoryController],
  providers: [WorkHistoryService],
  exports: [WorkHistoryService],
})
export class WorkHistoryModule {}
