import { Module } from '@nestjs/common';
import { WorkStatusService } from './work-status.service';
import { WorkStatusController } from './work-status.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkStatus } from './entities/work-status.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WorkStatus])],
  controllers: [WorkStatusController],
  providers: [WorkStatusService],
})
export class WorkStatusModule {}
