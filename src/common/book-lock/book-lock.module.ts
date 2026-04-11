import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookLockService } from './book-lock.service';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';

/**
 * BookLockModule
 *
 * Exposes BookLockService as a shared provider for any module that
 * mutates DevelopmentPlan, DevelopmentPlanRevision, or
 * DevelopmentPlanSupplement rows. Import this module into:
 *   - DevelopmentPlanModule (BE-BOOK-02)
 *   - DevelopmentPlanRevisionModule (BE-BOOK-03)
 *   - DevelopmentPlanSupplementModule (BE-BOOK-04)
 *   - BookAssemblyModule (BE-BOOK-05 — via assertMainBookNotFrozen delegation)
 *
 * The service has no dependency on any domain service — it only needs the
 * caller's EntityManager and the three book-artifact entity metadata — so
 * importing this module does not create circular dependencies.
 *
 * CLAUDE.md §15.7, §15.11.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DevelopmentPlan,
      DevelopmentPlanRevision,
      DevelopmentPlanSupplement,
    ]),
  ],
  providers: [BookLockService],
  exports: [BookLockService],
})
export class BookLockModule {}
