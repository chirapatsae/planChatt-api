import { Module } from '@nestjs/common';
import { GovernmentAgenciesService } from './government-agencies.service';
import { GovernmentAgenciesController } from './government-agencies.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GovernmentAgency } from './entities/government-agency.entity';

@Module({
  imports: [TypeOrmModule.forFeature([GovernmentAgency])],
  controllers: [GovernmentAgenciesController],
  providers: [GovernmentAgenciesService],
})
export class GovernmentAgenciesModule {}
