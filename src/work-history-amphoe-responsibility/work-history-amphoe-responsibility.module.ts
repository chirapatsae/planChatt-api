import { Module } from '@nestjs/common';
import { WorkHistoryAmphoeResponsibilityService } from './work-history-amphoe-responsibility.service';
import { WorkHistoryAmphoeResponsibilityController } from './work-history-amphoe-responsibility.controller';
import { WorkHistoryAmphoeResponsibility } from './entities/work-history-amphoe-responsibility.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { Amphoe } from '../amphoes/entities/amphoe.entity';
import { User } from '../users/entities/user.entity';
// W100 PR6 — UsersService is required to decrypt User PII before
// applying `maskEmail` on responsibility-table reads (cluster B6).
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorkHistoryAmphoeResponsibility,
      WorkHistory,
      Amphoe,
      User,
    ]),
    UsersModule,
  ],
  controllers: [WorkHistoryAmphoeResponsibilityController],
  providers: [WorkHistoryAmphoeResponsibilityService],
  exports: [WorkHistoryAmphoeResponsibilityService],
})
export class WorkHistoryAmphoeResponsibilityModule {}
