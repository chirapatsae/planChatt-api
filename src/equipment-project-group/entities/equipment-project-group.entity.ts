import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { EquipmentCategory } from 'src/equipment-category/entities/equipment-category.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Budget } from 'src/budget/entities/budget.entity';

/**
 * Wave Equipment ผ.03, Phase 2 — DB-02 (2026-05-28).
 *
 * Equipment project entity — a sibling of `ProjectGroup` /
 * `RevisedProjectGroup` / `SupplementProjectGroup`. Goes through the
 * full §12 TrackingStatus workflow (the `equipment_project_group_id`
 * nullable FK on `tracking_status` is the audit hook).
 *
 * # Locked decisions (2026-05-28)
 *
 * - **Q5 = B (dual format).** Both STRATEGY_BASED and ISSUE_BASED
 *   classification shapes are accepted. A DB CHECK constraint
 *   (`ck_equipment_project_group_shape`) enforces exactly-one-shape.
 *   `equipment_category_id` is REQUIRED in BOTH shapes — equipment is
 *   defined by its category.
 *
 * - **§16.5 indicator-relaxation.** PG's STRATEGY_BASED shape requires
 *   `indicator NOT NULL`; equipment relaxes that — equipment does not
 *   carry a KPI per user spec. `indicator` remains as a nullable column
 *   for forward-compatibility with PG tooling.
 *
 * - **Agency-only authoring** is enforced at the BE layer (BE-04's
 *   classification guard reads creator WorkHistory at request time —
 *   §1). NOT a DB CHECK / trigger; classification is not expressible
 *   as DDL.
 *
 * - **R3 = NO — no lineage columns.** No `prev_project_id` /
 *   `prev_project_type`. Phase 3 may add additively if equipment
 *   revision/change ever ships.
 *
 * - **§5 / §7 ResponsibleAgency lifecycle.** Equipment is agency-only
 *   by §1 classification at the BE layer; `responsible_agency_id` is
 *   therefore auto-populated at create time per §5.1, NOT deferred to
 *   staff. The column is nullable at the DB level to mirror PG (the
 *   §5.1 invariant is BE-enforced, not DDL-enforced).
 *
 * # Source of truth
 *
 * - CLAUDE.md §4 (WorkHistory ownership), §5 (project type &
 *   responsible agency lifecycle), §7 (responsibleAgency lifecycle),
 *   §10 (scope binding), §12 (audit), §14 (lineage — vacuous in v1),
 *   §16.5 (classification shape)
 * - docs/tasks/wave-equipment-pro3/DB-02-equipment-project-entity.md
 * - Phase 1 entity `EquipmentCategory`
 */
@Entity('equipment_project_groups')
// Dual-shape CHECK constraint per Q5=B locked decision. Declared on
// the entity so TypeORM's `synchronize:true` preserves it on reboot —
// without this decorator the constraint added by migration gets stripped
// the next time synchronize runs (verified empirically 2026-05-28).
@Check(
  'ck_equipment_project_group_shape',
  `equipment_category_id IS NOT NULL AND (
     (strategy_id IS NOT NULL AND tactic_id IS NOT NULL AND plan_id IS NOT NULL AND development_issue_id IS NULL)
     OR
     (strategy_id IS NULL AND tactic_id IS NULL AND plan_id IS NULL AND development_issue_id IS NOT NULL)
   )`,
)
export class EquipmentProjectGroup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ──────────────────────────────────────────────────────────────────
  // Equipment-specific content fields (user spec — five fields total)
  // ──────────────────────────────────────────────────────────────────

  /** ครุภัณฑ์ — item name. */
  @Column({ name: 'equipment_name', type: 'text' })
  equipmentName: string;

  /** เป้าหมาย / ผลผลิตของครุภัณฑ์. */
  @Column({ name: 'target_output', type: 'text' })
  targetOutput: string;

  /** ผลที่คาดว่าจะได้รับ. */
  @Column({ name: 'expected_results', type: 'text' })
  expectedResults: string;

  /**
   * KPI — intentionally NULLABLE in BOTH shapes per the §16.5
   * indicator-relaxation locked decision above. Kept on the table for
   * forward-compatibility with PG-shaped tooling.
   */
  @Column({ type: 'text', nullable: true })
  indicator: string | null;

  // ──────────────────────────────────────────────────────────────────
  // Engagement counters (mirror PG §17.3 advisory metadata)
  // ──────────────────────────────────────────────────────────────────

  @Column({ name: 'like_count', type: 'int', default: 0 })
  likeCount: number;

  @Column({ name: 'view_count', type: 'int', default: 0 })
  viewCount: number;

  // ──────────────────────────────────────────────────────────────────
  // Classification — DUAL SHAPE (§16.5 + Q5=B locked decision).
  // CHECK constraint enforces exactly-one-of:
  //   STRATEGY_BASED → (strategy, tactic, plan) NOT NULL + issue NULL
  //   ISSUE_BASED    → issue NOT NULL + (strategy, tactic, plan) NULL
  // Equipment category is REQUIRED in BOTH shapes.
  // ──────────────────────────────────────────────────────────────────

  @ManyToOne(() => Strategy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'strategy_id' })
  strategy: Strategy | null;

  @ManyToOne(() => Tactic, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'tactic_id' })
  tactic: Tactic | null;

  @ManyToOne(() => Plan, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan | null;

  @ManyToOne(() => DevelopmentIssue, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'development_issue_id' })
  developmentIssue: DevelopmentIssue | null;

  /**
   * Equipment-defining field. ON DELETE RESTRICT prevents orphaning
   * an equipment item by removing its category — categories are
   * reference data and rare to delete, but explicit RESTRICT documents
   * the intent.
   */
  @ManyToOne(() => EquipmentCategory, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'equipment_category_id' })
  equipmentCategory: EquipmentCategory;

  // ──────────────────────────────────────────────────────────────────
  // Book parent (§8 plan activation, §10 scope binding)
  // ──────────────────────────────────────────────────────────────────

  @ManyToOne(() => DevelopmentPlan, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'development_plan_id' })
  developmentPlan: DevelopmentPlan;

  // ──────────────────────────────────────────────────────────────────
  // Ownership (§4 — WorkHistory ownership, NOT user)
  // ──────────────────────────────────────────────────────────────────

  @ManyToOne(() => WorkHistory, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'create_by' })
  createdBy?: WorkHistory;

  // ──────────────────────────────────────────────────────────────────
  // Origin context — mirror PG (§5 / §7)
  // ──────────────────────────────────────────────────────────────────

  @ManyToOne(() => Amphoe, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'amphoe_id' })
  amphoe?: Amphoe;

  @ManyToOne(() => LocalAdministrativeOrganization, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'local_administrative_organization_id' })
  localAdministrativeOrganization?: LocalAdministrativeOrganization;

  @ManyToOne(() => LocalAdministrativeOrganization, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'origin_agency_id' })
  originAgencyId?: LocalAdministrativeOrganization;

  /**
   * §5.1 — auto-assigned at create time for agency-origin equipment
   * (BE-04). Nullable at DB level to mirror PG; the agency-only
   * invariant is enforced upstream by classification, not by DDL.
   */
  @ManyToOne(() => GovernmentAgency, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'responsible_agency_id' })
  responsibleAgency: GovernmentAgency | null;

  // ──────────────────────────────────────────────────────────────────
  // Book placement (2026-05-30) — parity with ProjectGroup
  // (`project-group.entity.ts:70-76`) and §20.3 Invariant 1 booked-state
  // columns. Equipment lives in the same draft book as projects, so it
  // carries the same booking placement fields. (likeCount / viewCount
  // already declared above.) synchronize:true creates these with the
  // declared defaults; legacy rows backfill to false / null.
  // ──────────────────────────────────────────────────────────────────

  @Column({ name: 'is_booked', default: false })
  isBooked: boolean;

  @Column({ name: 'booked_at', type: 'timestamptz', nullable: true })
  bookedAt: Date | null;

  @Column({ name: 'page_number', type: 'int', nullable: true })
  pageNumber: number | null;

  // ──────────────────────────────────────────────────────────────────
  // Polymorphic children (§12 audit + budget)
  // ──────────────────────────────────────────────────────────────────

  @OneToMany(() => Budget, (budget) => budget.equipmentProjectGroupId, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  budgets: Budget[];

  @OneToMany(
    () => TrackingStatus,
    (trackingStatus) => trackingStatus.equipmentProjectGroupId,
    {
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
  )
  trackingStatus: TrackingStatus[];

  // ──────────────────────────────────────────────────────────────────
  // Timestamps + soft-delete
  // ──────────────────────────────────────────────────────────────────

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date;
}
