import { Module } from '@nestjs/common';
import { StrategyService } from './strategy.service';
import { StrategyController } from './strategy.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Strategy } from './entities/strategy.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
// Wave LAO-ISSUE-STRATEGY-PARITY N1 — criteria registry lookup for
// GET /v1/strategy/:id/criteria endpoint.
import { CriteriaModule } from 'src/ai/criteria/criteria.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Strategy, ProjectGroup, WorkHistory]),
    CriteriaModule,
  ],
  controllers: [StrategyController],
  providers: [StrategyService],
})
export class StrategyModule {}
