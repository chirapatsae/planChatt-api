/**
 * ProjectAlignmentMapping — Triple-keyed alignment bridge.
 *
 * Maps (strategy, tactic, plan) — the internal LAO project
 * classification — to its corresponding (NS, MS, SDG, PS) — the
 * external strategic alignment.
 *
 * Each row corresponds to ONE Excel row in
 * `ตารางเชื่อมโยง ทำโปรแกรม.xlsx` (after combo / duplicate filtering).
 *
 * §12 — config rows; NO TrackingStatus interaction.
 * §4.1 — write authority = admin / super-admin (BE service gate);
 *        read = any authenticated user.
 *
 * --- Multi-value secondaries (Wave multi-national-strategy-per-alignment) ---
 *
 * Three external dimensions (NS, SDG, PS) now support MULTIPLE values
 * per triple via the sibling junction entities. The SCALAR FKs below
 * for `nationalStrategy` / `sdg` / `provinceStrategy` are RETAINED for
 * backward compatibility ONLY — they have NO business meaning of
 * "primary" / "ordering" / "priority". NEW code MUST read the
 * `nationalStrategies` / `sdgs` / `provinceStrategies` array relations.
 * See `docs/tasks/wave-multi-national-strategy-per-alignment/README.md`
 * §Scalar-FK Deprecation Contract.
 *
 * Milestone (col E) stays scalar — single-valued by nature; no junction.
 */

import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  UpdateDateColumn,
  Unique,
  Index,
} from 'typeorm';

import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { NationalStrategy } from 'src/national-strategy/entities/national-strategy.entity';
import { Milestone } from 'src/milestone/entities/milestone.entity';
import { Sdg } from 'src/sdg/entities/sdg.entity';
import { ProvinceStrategy } from 'src/province-strategy/entities/province-strategy.entity';
import { User } from 'src/users/entities/user.entity';
import { ProjectAlignmentNationalStrategy } from './project-alignment-national-strategy.entity';
import { ProjectAlignmentSdg } from './project-alignment-sdg.entity';
import { ProjectAlignmentProvinceStrategy } from './project-alignment-province-strategy.entity';

@Entity({ name: 'project_alignment_mapping' })
@Unique('UQ_project_alignment_triple', ['strategyId', 'tacticId', 'planId'])
@Index(['strategyId'])
@Index(['tacticId'])
@Index(['planId'])
export class ProjectAlignmentMapping {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // --- Internal classification triple (VARCHAR PKs) ---

  @Column({ name: 'strategy_id', type: 'varchar' })
  strategyId: string;

  @ManyToOne(() => Strategy, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'strategy_id' })
  strategy: Strategy;

  @Column({ name: 'tactic_id', type: 'varchar' })
  tacticId: string;

  @ManyToOne(() => Tactic, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'tactic_id' })
  tactic: Tactic;

  @Column({ name: 'plan_id', type: 'varchar' })
  planId: string;

  @ManyToOne(() => Plan, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan;

  // --- External strategic alignment (UUID PKs) ---

  /**
   * @deprecated FOR NEW CODE — kept for backward compatibility only.
   *
   * This scalar FK carries NO business meaning of "primary" /
   * "ordering" / "priority". It mirrors `nationalStrategies[0]` as
   * a pure implementation artifact. New code MUST read from the
   * `nationalStrategies[]` array relation instead.
   *
   * Will be removed in a future cleanup wave that drops the scalar
   * columns and stores all entries in the junction with `sort_order`.
   *
   * @see docs/tasks/wave-multi-national-strategy-per-alignment/README.md
   *      §Scalar-FK Deprecation Contract
   */
  @Column({ name: 'national_strategy_id', type: 'uuid' })
  nationalStrategyId: string;

  /**
   * @deprecated FOR NEW CODE — kept for backward compatibility only.
   *
   * This scalar FK carries NO business meaning of "primary" /
   * "ordering" / "priority". It mirrors `nationalStrategies[0]` as
   * a pure implementation artifact. New code MUST read from the
   * `nationalStrategies[]` array relation instead.
   *
   * Will be removed in a future cleanup wave that drops the scalar
   * columns and stores all entries in the junction with `sort_order`.
   *
   * @see docs/tasks/wave-multi-national-strategy-per-alignment/README.md
   *      §Scalar-FK Deprecation Contract
   */
  @ManyToOne(() => NationalStrategy, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'national_strategy_id' })
  nationalStrategy: NationalStrategy;

  @Column({ name: 'milestone_id', type: 'uuid' })
  milestoneId: string;

  @ManyToOne(() => Milestone, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'milestone_id' })
  milestone: Milestone;

  /**
   * @deprecated FOR NEW CODE — kept for backward compatibility only.
   *
   * This scalar FK carries NO business meaning of "primary" /
   * "ordering" / "priority". It mirrors `sdgs[0]` as a pure
   * implementation artifact. New code MUST read from the `sdgs[]`
   * array relation instead.
   *
   * Will be removed in a future cleanup wave that drops the scalar
   * columns and stores all entries in the junction with `sort_order`.
   *
   * @see docs/tasks/wave-multi-national-strategy-per-alignment/README.md
   *      §Scalar-FK Deprecation Contract
   */
  @Column({ name: 'sdg_id', type: 'uuid' })
  sdgId: string;

  /**
   * @deprecated FOR NEW CODE — kept for backward compatibility only.
   *
   * This scalar FK carries NO business meaning of "primary" /
   * "ordering" / "priority". It mirrors `sdgs[0]` as a pure
   * implementation artifact. New code MUST read from the `sdgs[]`
   * array relation instead.
   *
   * Will be removed in a future cleanup wave that drops the scalar
   * columns and stores all entries in the junction with `sort_order`.
   *
   * @see docs/tasks/wave-multi-national-strategy-per-alignment/README.md
   *      §Scalar-FK Deprecation Contract
   */
  @ManyToOne(() => Sdg, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sdg_id' })
  sdg: Sdg;

  /**
   * @deprecated FOR NEW CODE — kept for backward compatibility only.
   *
   * This scalar FK carries NO business meaning of "primary" /
   * "ordering" / "priority". It mirrors `provinceStrategies[0]` as
   * a pure implementation artifact. New code MUST read from the
   * `provinceStrategies[]` array relation instead.
   *
   * Will be removed in a future cleanup wave that drops the scalar
   * columns and stores all entries in the junction with `sort_order`.
   *
   * @see docs/tasks/wave-multi-national-strategy-per-alignment/README.md
   *      §Scalar-FK Deprecation Contract
   */
  @Column({ name: 'province_strategy_id', type: 'uuid' })
  provinceStrategyId: string;

  /**
   * @deprecated FOR NEW CODE — kept for backward compatibility only.
   *
   * This scalar FK carries NO business meaning of "primary" /
   * "ordering" / "priority". It mirrors `provinceStrategies[0]` as
   * a pure implementation artifact. New code MUST read from the
   * `provinceStrategies[]` array relation instead.
   *
   * Will be removed in a future cleanup wave that drops the scalar
   * columns and stores all entries in the junction with `sort_order`.
   *
   * @see docs/tasks/wave-multi-national-strategy-per-alignment/README.md
   *      §Scalar-FK Deprecation Contract
   */
  @ManyToOne(() => ProvinceStrategy, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'province_strategy_id' })
  provinceStrategy: ProvinceStrategy;

  // --- Multi-value secondaries (NEW — Wave multi-national-strategy-per-alignment) ---

  /**
   * SOURCE OF TRUTH for ยุทธศาสตร์ชาติ on this alignment row.
   * Use this for ALL new read paths.
   *
   * Ordering: by `sortOrder ASC` from the junction row. The scalar
   * `nationalStrategy` field is preserved purely as a back-compat
   * artifact mirroring `nationalStrategies[0]`; new code MUST read
   * this array and MUST NOT read the scalar.
   *
   * The scalar `nationalStrategy` FK is @deprecated and retained only
   * for backward compatibility — see README §Scalar-FK Deprecation
   * Contract in
   * `docs/tasks/wave-multi-national-strategy-per-alignment/README.md`.
   */
  @OneToMany(
    () => ProjectAlignmentNationalStrategy,
    (j) => j.mapping,
  )
  nationalStrategies: ProjectAlignmentNationalStrategy[];

  /**
   * SOURCE OF TRUTH for SDG on this alignment row.
   * Use this for ALL new read paths.
   *
   * Ordering: by `sortOrder ASC` from the junction row. The scalar
   * `sdg` field is preserved purely as a back-compat artifact mirroring
   * `sdgs[0]`; new code MUST read this array and MUST NOT read the
   * scalar.
   *
   * The scalar `sdg` FK is @deprecated and retained only for backward
   * compatibility — see README §Scalar-FK Deprecation Contract in
   * `docs/tasks/wave-multi-national-strategy-per-alignment/README.md`.
   */
  @OneToMany(
    () => ProjectAlignmentSdg,
    (j) => j.mapping,
  )
  sdgs: ProjectAlignmentSdg[];

  /**
   * SOURCE OF TRUTH for ยุทธศาสตร์จังหวัด on this alignment row.
   * Use this for ALL new read paths.
   *
   * Ordering: by `sortOrder ASC` from the junction row. The scalar
   * `provinceStrategy` field is preserved purely as a back-compat
   * artifact mirroring `provinceStrategies[0]`; new code MUST read
   * this array and MUST NOT read the scalar.
   *
   * The scalar `provinceStrategy` FK is @deprecated and retained only
   * for backward compatibility — see README §Scalar-FK Deprecation
   * Contract in
   * `docs/tasks/wave-multi-national-strategy-per-alignment/README.md`.
   */
  @OneToMany(
    () => ProjectAlignmentProvinceStrategy,
    (j) => j.mapping,
  )
  provinceStrategies: ProjectAlignmentProvinceStrategy[];

  // --- Audit ---

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedById: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by' })
  updatedBy: User | null;
}
