import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { SupplementEquipmentProjectGroup } from 'src/supplement-equipment-project-group/entities/supplement-equipment-project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { RolesGuard } from 'src/auth/roles.guard';

import { UnifiedEquipmentController } from './unified-equipment.controller';
import { UnifiedEquipmentService } from './unified-equipment.service';

/**
 * Wave Unified Equipment Tab — BE-01.
 *
 * Read-only unified equipment projection (EPG + RELPG, §14.2 HEAD-of-
 * lineage REPLACE semantic). The equipment analog of
 * `UnifiedProjectsModule`.
 *
 * No new `@Entity` is introduced — the service READS existing entities
 * via `createQueryBuilder` with eager joins. The `forFeature` registration
 * below provides the `@InjectRepository` tokens for the three roots the
 * service injects:
 *   - `EquipmentProjectGroup`         — EPG head-row query
 *   - `RevisedEquipmentProjectGroup`  — RELPG head-row query + anti-joins
 *   - `WorkHistory`                   — §4 owner-scope resolution +
 *                                       `WorkStatusApprovedGuard`
 *
 * All three entities are ALREADY registered in `app.module.ts`'s root
 * `entities: [...]` array (they are pre-existing), so no `app.module.ts`
 * `entities[]` change is required — only the module import.
 *
 * CLAUDE.md references:
 *   - §5.3  equipment sub-type; reads unrestricted.
 *   - §12   audit — read-only, no writes.
 *   - §14   lineage — HEAD anti-join via inline query (delegated semantic
 *           parity with `LineageLockService` discriminators).
 *   - §17.2 / §17.11 — advisory, no role exemption.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      EquipmentProjectGroup,
      RevisedEquipmentProjectGroup,
      SupplementEquipmentProjectGroup,
      WorkHistory,
    ]),
  ],
  controllers: [UnifiedEquipmentController],
  providers: [
    UnifiedEquipmentService,
    // Guards used by the controller's `@UseGuards(...)` chain. Registered
    // here so DI resolves them without leaning on the owning auth module
    // (mirrors `UnifiedProjectsModule`). `WorkStatusApprovedGuard` injects
    // a `Repository<WorkHistory>`; `RolesGuard` enforces the
    // `@Roles(...EXEC_READ)` gate on the executive-list route.
    RolesGuard,
    WorkStatusApprovedGuard,
  ],
  // Wave AI-Exec-Chat-Equipment-ผ.03 (2026-07-18) — exported so the
  // executive-chat `AggregationModule` can compose the canonical
  // HEAD-of-lineage equipment merge (`UnifiedEquipmentAggregatorService`
  // → `executiveList`) instead of re-implementing the §14.2 anti-joins.
  // Read-only consumption; no write surface is exposed (§17.2 / §17.3).
  exports: [UnifiedEquipmentService],
})
export class UnifiedEquipmentModule {}
