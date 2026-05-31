/**
 * ProjectAlignmentProvinceStrategy — Junction row carrying SECONDARY
 * ProvinceStrategy entries for a single `project_alignment_mapping`
 * triple.
 *
 * SOURCE OF TRUTH for ALL new read paths that need the full list of
 * ยุทธศาสตร์จังหวัด values attached to a given alignment triple. The
 * legacy scalar FK `project_alignment_mapping.province_strategy_id`
 * remains on the parent row purely for backward compatibility per the
 * Scalar-FK Deprecation Contract — see README §Scalar-FK Deprecation
 * Contract in
 * `docs/tasks/wave-multi-national-strategy-per-alignment/README.md`.
 *
 * §10 — scope binding: alignment is per-target-plan; this junction
 *        inherits scope transitively via `mapping.strategyId / tacticId
 *        / planId`.
 * §12 — config rows; NO TrackingStatus interaction.
 * §16.5 — STRATEGY_BASED only; ISSUE_BASED projects bypass the
 *        alignment resolver entirely.
 * §20 — parity: MAIN / EDIT / CHANGE / SUPPLEMENT all consume the
 *        same `AlignmentResolverService` projection, so this junction
 *        lands uniformly across all 4 subsystems.
 */

import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Unique,
  Index,
} from 'typeorm';

import { ProjectAlignmentMapping } from './project-alignment-mapping.entity';
import { ProvinceStrategy } from 'src/province-strategy/entities/province-strategy.entity';

@Entity({ name: 'project_alignment_province_strategy' })
@Unique('UQ_pa_ps_pair', ['mappingId', 'provinceStrategyId'])
@Index('IDX_pa_ps_mapping', ['mappingId'])
// Filter-readiness index (README §Filter-Ready Design Notes + DOCS-02).
// Phase 2 single-value / multi-value / count queries probe this column
// heavily on the reverse-lookup leg.
@Index('IDX_pa_ps_province_strategy', ['provinceStrategyId'])
export class ProjectAlignmentProvinceStrategy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'mapping_id', type: 'uuid' })
  mappingId: string;

  @ManyToOne(() => ProjectAlignmentMapping, (m) => m.provinceStrategies, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'mapping_id' })
  mapping: ProjectAlignmentMapping;

  @Column({ name: 'province_strategy_id', type: 'uuid' })
  provinceStrategyId: string;

  @ManyToOne(() => ProvinceStrategy, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'province_strategy_id' })
  provinceStrategy: ProvinceStrategy;

  /**
   * Display order. The scalar `mapping.province_strategy_id` is treated
   * as `sort_order = 0` (the back-compat primary mirror). Junction rows
   * start at `sort_order = 1`. The renderer uses this to keep render
   * order stable across deploys.
   *
   * NOTE — `sort_order` carries NO business "priority" semantics; it is
   * purely a deterministic display tie-breaker. See README §Scalar-FK
   * Deprecation Contract §3 (Sort order).
   */
  @Column({ name: 'sort_order', type: 'int', default: 1 })
  sortOrder: number;
}
