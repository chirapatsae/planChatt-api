import { Module } from '@nestjs/common';
import { TacticService } from './tactic.service';
import { TacticController } from './tactic.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tactic } from './entities/tactic.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { PlanTactic } from 'src/plan/entities/plan-tactic.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Tactic, ProjectGroup, WorkHistory, PlanTactic])],
  controllers: [TacticController],
  providers: [TacticService],
})
export class TacticModule {}
