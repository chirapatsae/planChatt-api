import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LineageLockService } from './lineage-lock.service';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';

/**
 * LineageLockModule
 *
 * Exposes LineageLockService as a shared provider for any module that mutates
 * ProjectGroup or RevisedProjectGroup rows. Import this module into:
 *   - ProjectGroupsModule (for BE-02)
 *   - RevisedProjectGroupModule (for BE-03)
 *   - TrackingStatusModule (for BE-04)
 *
 * The service has no dependency on any domain service — it only needs the
 * caller's EntityManager and the RevisedProjectGroup entity metadata — so
 * importing this module does not create circular dependencies.
 */
@Module({
  imports: [TypeOrmModule.forFeature([RevisedProjectGroup])],
  providers: [LineageLockService],
  exports: [LineageLockService],
})
export class LineageLockModule {}
