/**
 * Public Archive Module — anonymous read access to assembled
 * development plan books. Imported by AppModule alongside the
 * authenticated BookAssemblyModule (no overlap; this module declares
 * its own controller + service, only borrowing repositories + the
 * `getMergedPdfPath` helper from BookAssemblyService).
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BookAssemblyVersion } from 'src/book-assembly/entities/book-assembly-version.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { BookAssemblyModule } from 'src/book-assembly/book-assembly.module';

import { PublicArchiveController } from './public-archive.controller';
import { PublicArchiveService } from './public-archive.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BookAssemblyVersion,
      DevelopmentPlan,
      DevelopmentPlanRevision,
      ProjectGroup,
      RevisedProjectGroup,
    ]),
    // BookAssemblyModule exports BookAssemblyService — we use it for
    // `getMergedPdfPath` only (file resolution; no auth side-effects).
    BookAssemblyModule,
  ],
  controllers: [PublicArchiveController],
  providers: [PublicArchiveService],
})
export class PublicArchiveModule {}
