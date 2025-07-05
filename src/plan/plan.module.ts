import { Module } from '@nestjs/common';
import { PlanService } from './plan.service';
import { PlanController } from './plan.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Plan } from './entities/plan.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { PlanTactic } from './entities/plan-tactic.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Plan , Tactic ,PlanTactic , ProjectGroup])],
  controllers: [PlanController],
  providers: [PlanService],
})
export class PlanModule {}
