import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProjectAlignmentMapping } from './entities/project-alignment-mapping.entity';
import { ProjectAlignmentNationalStrategy } from './entities/project-alignment-national-strategy.entity';
import { ProjectAlignmentSdg } from './entities/project-alignment-sdg.entity';
import { ProjectAlignmentProvinceStrategy } from './entities/project-alignment-province-strategy.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { ProjectAlignmentMappingService } from './project-alignment-mapping.service';
import { ProjectAlignmentMappingController } from './project-alignment-mapping.controller';
import { AlignmentResolverService } from './alignment-resolver.service';

/**
 * ProjectAlignmentMappingModule — bridge between internal LAO project
 * classification (strategy / tactic / plan) and external strategic
 * alignment (NS / MS / SDG / PS).
 *
 * Mounted route prefix: `/v1/strategic-graph/alignment`.
 *
 * NOTE — Wave 41 footgun: the entity MUST also appear in
 * `TypeOrmModule.forRoot({ entities: [...] })` in `app.module.ts`,
 * otherwise TypeORM throws `EntityMetadataNotFoundError` at boot.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProjectAlignmentMapping,
      // Wave multi-national-strategy-per-alignment / DB-01 — 3 uniform
      // junctions for multi-value secondaries on NS / SDG / PS. Must
      // ALSO appear in `app.module.ts` `forRoot.entities` per the
      // Wave 41 dual-registration rule (TEMPLATE.md §8.1).
      ProjectAlignmentNationalStrategy,
      ProjectAlignmentSdg,
      ProjectAlignmentProvinceStrategy,
      WorkHistory,
    ]),
  ],
  controllers: [ProjectAlignmentMappingController],
  providers: [ProjectAlignmentMappingService, AlignmentResolverService],
  exports: [
    TypeOrmModule,
    ProjectAlignmentMappingService,
    AlignmentResolverService,
  ],
})
export class ProjectAlignmentMappingModule {}
