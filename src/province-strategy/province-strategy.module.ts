import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProvinceStrategy } from './entities/province-strategy.entity';
import { ProvinceStrategyService } from './province-strategy.service';
import { ProvinceStrategyController } from './province-strategy.controller';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ProvinceStrategy, WorkHistory])],
  controllers: [ProvinceStrategyController],
  providers: [ProvinceStrategyService],
  exports: [ProvinceStrategyService],
})
export class ProvinceStrategyModule {}
