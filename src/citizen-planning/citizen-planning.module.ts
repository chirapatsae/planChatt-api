import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WorkHistory } from '../work-history/entities/work-history.entity';
import { RolesGuard } from '../auth/roles.guard';
import { WorkStatusApprovedGuard } from '../auth/work-status-approved.guard';
import { CitizenPost } from '../citizen-engagement/entities/citizen-post.entity';
import { CitizenPlanningEntry } from './entities/citizen-planning-entry.entity';
import { CitizenIdeaScoreSnapshot } from './entities/citizen-idea-score-snapshot.entity';
import { CitizenPlanningController } from './citizen-planning.controller';
import { CitizenPlanningService } from './citizen-planning.service';
import { CitizenIdeaScoreService } from './citizen-idea-score.service';

/**
 * Executive private planning layer for the citizen idea board (§17.2 advisory /
 * §17.3 isolation). `WorkHistory` is imported so `WorkStatusApprovedGuard` (its
 * live §2 work-status read) and `CitizenPlanningService` (owner resolution) can
 * inject `Repository<WorkHistory>`. `RolesGuard` + `WorkStatusApprovedGuard`
 * are provided per the canonical executive-controller module wiring.
 *
 * B2 trend: `CitizenIdeaScoreService` reads `CitizenPost` (cached engagement
 * totals) and writes daily `CitizenIdeaScoreSnapshot` rows — both registered
 * here via `forFeature`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CitizenPlanningEntry,
      CitizenIdeaScoreSnapshot,
      CitizenPost,
      WorkHistory,
    ]),
  ],
  controllers: [CitizenPlanningController],
  providers: [
    CitizenPlanningService,
    CitizenIdeaScoreService,
    RolesGuard,
    WorkStatusApprovedGuard,
  ],
})
export class CitizenPlanningModule {}
