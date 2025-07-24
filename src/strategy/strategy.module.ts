import { Module } from '@nestjs/common';
import { StrategyService } from './strategy.service';
import { StrategyController } from './strategy.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Strategy } from './entities/strategy.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Strategy, ProjectGroup, WorkHistory])],
  controllers: [StrategyController],
  providers: [StrategyService],
})
export class StrategyModule {}
