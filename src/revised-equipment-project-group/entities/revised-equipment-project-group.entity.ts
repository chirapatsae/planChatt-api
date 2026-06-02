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

import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { EquipmentCategory } from 'src/equipment-category/entities/equipment-category.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { AttachmentRevisedEquipmentProjectGroup } from 'src/attachment-revised-equipment-project-groups/entities/attachment-revised-equipment-project-group.entity';
import { PrevEquipmentProjectType } from '../dto/prev-equipment-project-type.enum';

/**
 * Wave Equipment Revision Management — DB-01 (Phase 3).
 *
 * `RevisedEquipmentProjectGroup` (RELPG) — the equipment (ผ.03) analog
 * of `RevisedProjectGroup`. A full lineage fork from an approved
 * `EquipmentProjectGroup` into a `DevelopmentPlanRevision` context.
 *
 * Structural template: `RevisedProjectGroup` (FK pattern, lineage
 * columns, booked-state, ownership). Content-field template:
 * `EquipmentProjectGroup` (equipment_name / target_output /
 * expected_results / indicator / equipment_category, dual-shape CHECK,
 * agency/origin context, engagement counters).
 *
 * # Locked decisions
 *
 * - **Dual-shape CHECK (§16.5 + Q5=B).** `ck_revised_equipment_project_group_shape`
 *   mirrors EPG exactly: `equipment_category_id IS NOT NULL` in BOTH
 *   shapes, exactly-one-of STRATEGY_BASED / ISSUE_BASED, and `indicator`
 *   intentionally OMITTED from the CHECK (equipment relaxes PG's
 *   `indicator NOT NULL` clause in BOTH shapes per the §16.5
 *   indicator-relaxation). Declared on the entity so TypeORM's
 *   `synchronize:true` preserves it on reboot — without this decorator
 *   the constraint added by migration gets stripped the next time
 *   synchronize runs (EPG sets this precedent, verified empirically
 *   2026-05-28).
 *
 * - **Lineage columns (§14).** `prev_project_id` (uuid) +
 *   `prev_project_type` (varchar) carry the `(prevProjectId,
 *   prevProjectType)` edge. Initial value `'equipment'` points at the
 *   source EPG; chained RELPG-to-RELPG forks use `'revised_equipment'`.
 *   The column is a plain varchar (NOT a shared Postgres enum) per the
 *   §7.2 decision — see `PrevEquipmentProjectType`.
 *
 * - **Booked-state (§20.3 Invariant 1).** `is_booked` / `booked_at` /
 *   `page_number` — parity with PG / RPG / SPG.
 *
 * - **Agency-only authoring** is BE-enforced (creator WorkHistory
 *   classification per §1); equipment is agency-origin only by §5.3
 *   construction, so `responsible_agency_id` is auto-assigned at create
 *   time per §5.1. Nullable at DB level to mirror EPG/PG.
 *
 * # Source of truth
 *
 * - CLAUDE.md §4 / §5.3 / §11 / §12 / §14 / §14.7 / §16.5 / §18 /
 *   §20.3 Invariant 1
 * - docs/tasks/wave-equipment-revision-management/DB-01-revised-equipment-entity-and-migration.md
 */
@Entity('revised_equipment_project_groups')
// Dual-shape CHECK constraint per §16.5 + Q5=B. Declared on the entity
// so TypeORM's `synchronize:true` preserves it on reboot (EPG precedent).
// `indicator` is intentionally NOT part of the CHECK — equipment relaxes
// PG's `indicator NOT NULL` clause in BOTH shapes.
@Check(
  'ck_revised_equipment_project_group_shape',
  `equipment_category_id IS NOT NULL AND (
     (strategy_id IS NOT NULL AND tactic_id IS NOT NULL AND plan_id IS NOT NULL AND development_issue_id IS NULL)
     OR
     (strategy_id IS NULL AND tactic_id IS NULL AND plan_id IS NULL AND development_issue_id IS NOT NULL)
   )`,
)
export class RevisedEquipmentProjectGroup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ──────────────────────────────────────────────────────────────────
  // Identity and parent book (§8 plan activation, §10 scope binding)
  // ──────────────────────────────────────────────────────────────────

  @ManyToOne(() => DevelopmentPlanRevision, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'development_plan_revision_id' })
  developmentPlanRevision: DevelopmentPlanRevision;

  /** Denormalized parent plan reference for §10 scope binding. */
  @ManyToOne(() => DevelopmentPlan, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'development_plan_id' })
  developmentPlan?: DevelopmentPlan;

  // ──────────────────────────────────────────────────────────────────
  // Source EPG reference (lineage root)
  // ──────────────────────────────────────────────────────────────────

  @ManyToOne(() => EquipmentProjectGroup, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'equipment_project_group_id' })
  equipmentProjectGroup: EquipmentProjectGroup | null;

  // ──────────────────────────────────────────────────────────────────
  // Lineage columns (§14)
  // ──────────────────────────────────────────────────────────────────

  @Column({ name: 'prev_project_id', type: 'uuid', nullable: true })
  prevProjectId?: string | null;

  /**
   * §7.2 decision — plain varchar column (NOT a shared Postgres enum).
   * The TS-level `PrevEquipmentProjectType` enum bounds valid values
   * (`'equipment' | 'revised_equipment'`).
   */
  @Column({
    name: 'prev_project_type',
    type: 'varchar',
    nullable: true,
  })
  prevProjectType?: PrevEquipmentProjectType | null;

  // ──────────────────────────────────────────────────────────────────
  // Equipment content fields (copied from EPG — all mutable on RELPG)
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
   * Free-form revision request reason — the equipment analog of
   * `RevisedProjectGroup.additionalDetail`. Captured by the equipment
   * revision wizard so the author can explain why the fork/edit is being
   * requested. Nullable; does NOT participate in workflow / shape / lineage
   * validation (additive metadata only).
   */
  @Column({ name: 'reason', type: 'text', nullable: true })
  reason: string | null;

  /**
   * KPI — intentionally NULLABLE in BOTH shapes per the §16.5
   * indicator-relaxation (same as EPG). Kept on the table for
   * forward-compatibility with PG-shaped tooling.
   */
  @Column({ type: 'text', nullable: true })
  indicator: string | null;

  /**
   * Equipment-defining field. ON DELETE RESTRICT prevents orphaning an
   * equipment item by removing its category (reference data). Mirrors
   * EPG.
   */
  @ManyToOne(() => EquipmentCategory, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'equipment_category_id' })
  equipmentCategory: EquipmentCategory;

  // ──────────────────────────────────────────────────────────────────
  // Classification — DUAL SHAPE (§16.5 + Q5=B).
  // CHECK constraint (declared above) enforces exactly-one-of:
  //   STRATEGY_BASED → (strategy, tactic, plan) NOT NULL + issue NULL
  //   ISSUE_BASED    → issue NOT NULL + (strategy, tactic, plan) NULL
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

  /**
   * CLAUDE.md §16 Multi-Format Reporting — ISSUE_BASED classification.
   * Copy-on-fork (§16.6): when forking an ISSUE_BASED EquipmentProjectGroup
   * into a RELPG the FK is copied unchanged — the referenced
   * DevelopmentIssue row is NOT duplicated.
   */
  @ManyToOne(() => DevelopmentIssue, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'development_issue_id' })
  developmentIssue: DevelopmentIssue | null;

  // ──────────────────────────────────────────────────────────────────
  // Ownership (§4 — WorkHistory ownership, NOT user)
  // ──────────────────────────────────────────────────────────────────

  @ManyToOne(() => WorkHistory, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'create_by' })
  createdBy?: WorkHistory;

  // ──────────────────────────────────────────────────────────────────
  // Origin context — mirror EPG/PG (§5 / §7)
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
   * §5.1 — auto-assigned at create time for agency-origin equipment.
   * Nullable at DB level to mirror EPG/PG; the agency-only invariant is
   * enforced upstream by classification, not by DDL.
   */
  @ManyToOne(() => GovernmentAgency, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'responsible_agency_id' })
  responsibleAgency: GovernmentAgency | null;

  // ──────────────────────────────────────────────────────────────────
  // Booked-state (§20.3 Invariant 1) — parity with PG / RPG / SPG / EPG
  // ──────────────────────────────────────────────────────────────────

  @Column({ name: 'is_booked', default: false })
  isBooked: boolean;

  @Column({ name: 'booked_at', type: 'timestamptz', nullable: true })
  bookedAt: Date | null;

  @Column({ name: 'page_number', type: 'int', nullable: true })
  pageNumber: number | null;

  // ──────────────────────────────────────────────────────────────────
  // Engagement counters (§17.3 advisory metadata — mirror EPG)
  // ──────────────────────────────────────────────────────────────────

  @Column({ name: 'like_count', type: 'int', default: 0 })
  likeCount: number;

  @Column({ name: 'view_count', type: 'int', default: 0 })
  viewCount: number;

  // ──────────────────────────────────────────────────────────────────
  // Polymorphic children (§12 audit + budget)
  // ──────────────────────────────────────────────────────────────────

  @OneToMany(
    () => Budget,
    (budget) => budget.revisedEquipmentProjectGroupId,
    {
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
  )
  budgets: Budget[];

  @OneToMany(
    () => TrackingStatus,
    (trackingStatus) => trackingStatus.revisedEquipmentProjectGroupId,
    {
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
  )
  trackingStatus: TrackingStatus[];

  /**
   * Inverse side of the equipment-revision attachment relation. Mirrors
   * `RevisedProjectGroup.attachments`. Files are uploaded via the
   * `/v1/attachment-revised-equipment-project-groups` surface.
   */
  @OneToMany(
    () => AttachmentRevisedEquipmentProjectGroup,
    (attachment) => attachment.revisedEquipmentProjectGroup,
    {
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
  )
  attachments: AttachmentRevisedEquipmentProjectGroup[];

  // ──────────────────────────────────────────────────────────────────
  // Timestamps + soft-delete
  // ──────────────────────────────────────────────────────────────────

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date;
}
