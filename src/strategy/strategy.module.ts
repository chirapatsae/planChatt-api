import { Module } from '@nestjs/common';
import { StrategyService } from './strategy.service';
import { StrategyController } from './strategy.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Strategy } from './entities/strategy.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';

@Module({
  imports : [TypeOrmModule.forFeature([Strategy , ProjectGroup])],
  controllers: [StrategyController],
  providers: [StrategyService],
})
export class StrategyModule {}
