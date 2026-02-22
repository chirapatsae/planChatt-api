import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExecutiveService } from './executive.service';
import { ExecutiveController } from './executive.controller';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WorkHistory, ProjectGroup, DevelopmentPlan])],
  controllers: [ExecutiveController],
  providers: [ExecutiveService],
})
export class ExecutiveModule { }
