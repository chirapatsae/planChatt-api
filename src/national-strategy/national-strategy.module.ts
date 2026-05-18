import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NationalStrategy } from './entities/national-strategy.entity';
import { NationalStrategyService } from './national-strategy.service';
import { NationalStrategyController } from './national-strategy.controller';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

@Module({
  imports: [TypeOrmModule.forFeature([NationalStrategy, WorkHistory])],
  controllers: [NationalStrategyController],
  providers: [NationalStrategyService],
  exports: [NationalStrategyService],
})
export class NationalStrategyModule {}
