import { Module } from '@nestjs/common';
import { WorkHistoryGovernmentAgencyResponsibilityService } from './work-history-government-agency-responsibility.service';
import { WorkHistoryGovernmentAgencyResponsibilityController } from './work-history-government-agency-responsibility.controller';
import { WorkHistoryGovernmentAgencyResponsibility } from './entities/work-history-government-agency-responsibility.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { GovernmentAgency } from '../government-agencies/entities/government-agency.entity';
import { User } from '../users/entities/user.entity';
// W100 PR6 — UsersService is required to decrypt User PII before
// applying `maskEmail` on responsibility-table reads (cluster B6).
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorkHistoryGovernmentAgencyResponsibility,
      WorkHistory,
      GovernmentAgency,
      User,
    ]),
    UsersModule,
  ],
  controllers: [WorkHistoryGovernmentAgencyResponsibilityController],
  providers: [WorkHistoryGovernmentAgencyResponsibilityService],
  exports: [WorkHistoryGovernmentAgencyResponsibilityService],
})
export class WorkHistoryGovernmentAgencyResponsibilityModule {}
