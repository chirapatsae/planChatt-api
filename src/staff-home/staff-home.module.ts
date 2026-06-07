import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TrackingStatus } from '../tracking-status/entities/tracking-status.entity';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { StaffHomeController } from './staff-home.controller';
import { StaffHomeService } from './staff-home.service';

/**
 * StaffHomeModule — wave-staff-review-dashboard Phase 2.
 *
 * Read-only aging/overdue aggregator (§17.2 advisory / §18.13 read-side
 * aggregator). Registers ONLY the repositories it reads from; it writes
 * nothing.
 */
@Module({
  imports: [TypeOrmModule.forFeature([TrackingStatus, WorkHistory])],
  controllers: [StaffHomeController],
  providers: [StaffHomeService],
})
export class StaffHomeModule {}
