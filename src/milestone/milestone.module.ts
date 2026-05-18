import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Milestone } from './entities/milestone.entity';
import { MilestoneService } from './milestone.service';
import { MilestoneController } from './milestone.controller';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Milestone, WorkHistory])],
  controllers: [MilestoneController],
  providers: [MilestoneService],
  exports: [MilestoneService],
})
export class MilestoneModule {}
