import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EquipmentCategory } from './entities/equipment-category.entity';
import { EquipmentCategoryScope } from './entities/equipment-category-scope.entity';
import { EquipmentCategoryService } from './equipment-category.service';
import { EquipmentCategoryController } from './equipment-category.controller';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { RolesGuard } from 'src/auth/roles.guard';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';

/**
 * Wave Equipment ผ.03, Phase 1.
 *
 * DB-01 shipped entity registration only. BE-01 wires the
 * controller + service + auxiliary guards.
 *
 * `WorkHistory` is registered via `forFeature` here so the injected
 * `Repository<WorkHistory>` inside `WorkStatusApprovedGuard` resolves
 * cleanly (same pattern as `UnifiedProjectsModule`).
 *
 * Per TEMPLATE.md §8.1 (Entity Registration Checklist), all three
 * entities are ALSO registered at the root DataSource in
 * `app.module.ts` — `forFeature` alone is insufficient when the root
 * uses an explicit `entities[]` list (Wave 41 footgun).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      EquipmentCategory,
      EquipmentCategoryScope,
      WorkHistory,
    ]),
  ],
  controllers: [EquipmentCategoryController],
  providers: [EquipmentCategoryService, RolesGuard, WorkStatusApprovedGuard],
  exports: [TypeOrmModule, EquipmentCategoryService],
})
export class EquipmentCategoryModule {}
