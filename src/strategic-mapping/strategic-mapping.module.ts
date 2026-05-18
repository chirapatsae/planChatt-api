import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// CHAIN-CLEANUP 2026-05-18: schema narrowed to strict
// NS→MS→SDG→PS chain. Dropped entities:
//   - SdgNationalStrategy (table sdg_national_strategy)
//   - ProvinceStrategyNationalStrategy (table province_strategy_national_strategy)
//   - MilestoneProvinceStrategy (table milestone_province_strategy)
// Row backup: backups/strategic_cross_links_2026-05-18.sql.
import { MilestoneSdg } from './entities/milestone-sdg.entity';
import { ProvinceStrategySdg } from './entities/province-strategy-sdg.entity';
// CLEANUP 2026-05-18: dropped 4 orphan plan-mapping entities
// (PlanSdg / PlanNationalStrategy / PlanMilestone / PlanProvinceStrategy)
// plus their tables — all 0 rows, no UI consumer.
import { NationalStrategyMilestone } from './entities/national-strategy-milestone.entity';

// BE-04 — master repos for source/target existence validation in the
// inter-master replace flow. Each is also registered at the root
// DataSource via its own feature module (BE-01); the `forFeature` line
// here only provides the per-module repository injection token used by
// `StrategicMappingService`.
import { Sdg } from 'src/sdg/entities/sdg.entity';
import { NationalStrategy } from 'src/national-strategy/entities/national-strategy.entity';
import { Milestone } from 'src/milestone/entities/milestone.entity';
import { ProvinceStrategy } from 'src/province-strategy/entities/province-strategy.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

import { StrategicMappingService } from './strategic-mapping.service';
import { StrategicMappingController } from './strategic-mapping.controller';

/**
 * Strategic Graph BE-03 + BE-04 — Junction entities module.
 *
 * BE-03 — consolidates the 8 inter-master and plan-mapping junction
 * entities for dependency injection.
 *
 * BE-04 — adds the inter-master replace API
 * (`StrategicMappingController` + `StrategicMappingService`) mounted at
 * `/v1/strategic-graph/mapping/:type`. Plan-mapping endpoint (BE-05)
 * and plan-filter endpoint (BE-06) remain owned by their respective
 * upcoming nodes and are NOT mounted here.
 *
 * Wave 41 footgun: every entity must also be listed in
 * `TypeOrmModule.forRoot({ entities: [...] })` in `app.module.ts`.
 * `forFeature` only registers the repository injection token — root
 * registration provides the metadata.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Strategic chain junctions (3) — NS→MS→SDG↔PS
      NationalStrategyMilestone,
      MilestoneSdg,
      ProvinceStrategySdg,
      // BE-04 — master repos for source/target existence validation
      Sdg,
      NationalStrategy,
      Milestone,
      ProvinceStrategy,
      // BE-04 — WorkHistory repo for the role/workStatus gate
      WorkHistory,
      // BE-05 — Plan repo for composite plan-mapping existence check
      Plan,
    ]),
  ],
  controllers: [StrategicMappingController],
  providers: [StrategicMappingService],
  exports: [TypeOrmModule, StrategicMappingService],
})
export class StrategicMappingModule {}
