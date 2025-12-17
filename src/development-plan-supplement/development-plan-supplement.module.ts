import { Module } from '@nestjs/common';
import { DevelopmentPlanSupplementService } from './development-plan-supplement.service';
import { DevelopmentPlanSupplementController } from './development-plan-supplement.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevelopmentPlanSupplement } from './entities/development-plan-supplement.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { UsersModule } from 'src/users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DevelopmentPlanSupplement,
      DevelopmentPlan,
      WorkHistory,
    ]),
    UsersModule,
  ],
  controllers: [DevelopmentPlanSupplementController],
  providers: [DevelopmentPlanSupplementService],
  exports: [DevelopmentPlanSupplementService],
})
export class DevelopmentPlanSupplementModule {}

