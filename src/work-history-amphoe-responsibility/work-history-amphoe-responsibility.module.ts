import { Module } from '@nestjs/common';
import { WorkHistoryAmphoeResponsibilityService } from './work-history-amphoe-responsibility.service';
import { WorkHistoryAmphoeResponsibilityController } from './work-history-amphoe-responsibility.controller';
import { WorkHistoryAmphoeResponsibility } from './entities/work-history-amphoe-responsibility.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { Amphoe } from '../amphoes/entities/amphoe.entity';
import { User } from '../users/entities/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorkHistoryAmphoeResponsibility,
      WorkHistory,
      Amphoe,
      User,
    ]),
  ],
  controllers: [WorkHistoryAmphoeResponsibilityController],
  providers: [WorkHistoryAmphoeResponsibilityService],
  exports: [WorkHistoryAmphoeResponsibilityService],
})
export class WorkHistoryAmphoeResponsibilityModule {}
