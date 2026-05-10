import { Module } from '@nestjs/common';
import { DevelopmentPlanSupplementService } from './development-plan-supplement.service';
import { DevelopmentPlanSupplementController } from './development-plan-supplement.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevelopmentPlanSupplement } from './entities/development-plan-supplement.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { UsersModule } from 'src/users/users.module';
import { BookLockModule } from 'src/common/book-lock/book-lock.module';
import { OrphanCleanupModule } from 'src/orphan-cleanup/orphan-cleanup.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DevelopmentPlanSupplement,
      DevelopmentPlan,
      WorkHistory,
    ]),
    UsersModule,
    BookLockModule,
    // Wave 110 W110-BE-01 — supplement softRemove invokes the
    // orphan-cleanup cascade (CLAUDE.md §18.2.1 SUPPLEMENT trigger).
    OrphanCleanupModule,
  ],
  controllers: [DevelopmentPlanSupplementController],
  providers: [DevelopmentPlanSupplementService],
  exports: [DevelopmentPlanSupplementService],
})
export class DevelopmentPlanSupplementModule {}

