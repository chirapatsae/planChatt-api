import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProjectAlignmentMapping } from './entities/project-alignment-mapping.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { ProjectAlignmentMappingService } from './project-alignment-mapping.service';
import { ProjectAlignmentMappingController } from './project-alignment-mapping.controller';

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
  imports: [TypeOrmModule.forFeature([ProjectAlignmentMapping, WorkHistory])],
  controllers: [ProjectAlignmentMappingController],
  providers: [ProjectAlignmentMappingService],
  exports: [TypeOrmModule, ProjectAlignmentMappingService],
})
export class ProjectAlignmentMappingModule {}
