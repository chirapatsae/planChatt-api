import { Budget } from 'src/budget/entities/budget.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  JoinColumn,
  DeleteDateColumn,
  OneToMany,
} from 'typeorm';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
// SUPP-3 / BE-07 — SPG attachment relation (mirrors PG / RPG patterns).
import { AttachmentSupplementProjectGroup } from 'src/attachment-supplement-project-groups/entities/attachment-supplement-project-group.entity';

@Entity('supplement_project_groups')
export class SupplementProjectGroup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => DevelopmentPlanSupplement, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'development_plan_supplement_id' })
  developmentPlanSupplement: DevelopmentPlanSupplement;

  @Column()
  title: string;

  @Column('text')
  objective: string;

  @Column('text')
  goal: string;

  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  startLat: number | null;
  
  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  startLng: number | null;
  
  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  endLat: number | null;
  
  @Column('decimal', { precision: 10, scale: 7, nullable: true })
  endLng: number | null;

  /**
   * CLAUDE.md §16.5 — nullable for ISSUE_BASED plans.
   * A DB CHECK constraint enforces exactly-one-shape together with
   * strategy_id / tactic_id / plan_id / development_issue_id.
   */
  @Column('text', { nullable: true })
  indicator: string | null;

  @Column('text')
  expected: string;

  @Column()
  projectYear: number;

  /** Legacy column kept for schema stability — SPG has no draft state; always false. */
  @Column({ default: false })
  isDraft: boolean;

  @Column({ name: 'is_latest', default: true })
  isLatest: boolean;

  @Column({ type: 'int', nullable: true })
  pageNumber: number | null;

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
   * Mutually exclusive with (strategy, tactic, plan, indicator) per the
   * §16.5 shape invariant.
   */
  @ManyToOne(() => DevelopmentIssue, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'development_issue_id' })
  developmentIssue: DevelopmentIssue | null;

  @ManyToOne(
    () => WorkHistory,
    (workHistory) => workHistory.creatorProjectGroup,
  )
  @JoinColumn({ name: 'create_by' })
  createdBy?: WorkHistory;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @ManyToOne(
    () => LocalAdministrativeOrganization,
    (lao) => lao.originAgencyProjectGroup,
    {
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
      nullable: true,
    },
  )
  @JoinColumn({ name: 'origin_agency_id' })
  originAgencyId: LocalAdministrativeOrganization;

  /**
   * CLAUDE.md §15 book lineage — Wave 55 W55-DB-01.
   * Nullable FK to `amphoes(id)` (ON DELETE SET NULL) that enables
   * province-level amphoe aggregation for SPG rows inside the
   * Executive Chat geo-enrichment pipeline (W55-BE-04). Mirrors the
   * pattern used by ProjectGroup / RevisedProjectGroup: only the
   * relation is declared, no separate scalar column. Historical rows
   * remain NULL by design — no backfill.
   */
  @ManyToOne(
    () => Amphoe,
    {
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
      nullable: true,
    },
  )
  @JoinColumn({ name: 'amphoe_id' })
  amphoe?: Amphoe | null;

  /**
   * Task `SUPP_SPG_LAO_COLUMN` (2026-05-12) — creator-LAO denormalized
   * column for shape-symmetry with PG / RPG (see PG entity line 151-161,
   * RPG entity line 162-171). Set at INSERT only from the creator's
   * WorkHistory; immutable thereafter per CLAUDE.md §5. The update DTO
   * does NOT accept this field.
   *
   * For the current Q1+Q2 supplement gate (agency-only) this is always
   * `'3001027'`, but the assignment is shape-symmetric with PG / RPG and
   * future-proofs for scope widening.
   *
   * No inverse declared (matches the PG / RPG sibling and the SPG
   * `amphoe` relation pattern — no `@OneToMany` exists on the
   * `LocalAdministrativeOrganization` side for SPG).
   */
  @ManyToOne(
    () => LocalAdministrativeOrganization,
    {
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
      nullable: true,
    },
  )
  @JoinColumn({ name: 'local_administrative_organization_id' })
  localAdministrativeOrganization?: LocalAdministrativeOrganization | null;

  @ManyToOne(
    () => GovernmentAgency,
    (governmentAgency) => governmentAgency.responsibleAgencyProjectGroup,
    {
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    }, 
  )
  @JoinColumn({ name: 'responsible_agency_id' })
  responsibleAgency: GovernmentAgency;

  @OneToMany(() => Budget, (budget) => budget.supplementProjectGroupId, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  budgets: Budget[];

  @OneToMany(() => TrackingStatus, (trackingStatus) => trackingStatus.supplementProjectGroupId, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  trackingStatus: TrackingStatus[];

  // Free-form additional detail field for extra description
  @Column('text', { nullable: true })
  additionalDetail: string | null;

  /**
   * Denormalized engagement counters (Wave public-archive-supplement
   * BE-01). Mirror the `project_groups` / `revised_project_groups`
   * shape — both default to 0 (non-null). CLAUDE.md §17.2 advisory;
   * never gates workflow. The increment paths live in
   * `PublicEngagementService` and use UUID-only `target_id` rows in
   * `engagement_likes` / `engagement_view_events` per §17.3 audit
   * separation (no FK to this table).
   */
  @Column({ name: 'like_count', type: 'int', default: 0 })
  likeCount: number;

  @Column({ name: 'view_count', type: 'int', default: 0 })
  viewCount: number;

  /**
   * SUPP-3 / BE-07 — Attachments uploaded against this SPG. The FK on
   * `attachment_supplement_project_groups` uses `ON DELETE RESTRICT`
   * (NOT `CASCADE`) so the §12 audit trail survives SPG soft-delete.
   * Adding rows here changes the §17.4 baseline `content_hash`, but
   * the snapshot is `snapshot-only` so no auto-recompute fires.
   */
  @OneToMany(
    () => AttachmentSupplementProjectGroup,
    (attachment) => attachment.supplementProjectGroup,
    {
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    },
  )
  attachments: AttachmentSupplementProjectGroup[];
}


