import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * CitizenPlanningEntry — a single executive's PRIVATE triage state on ONE
 * citizen idea (the executive "บอร์ดวางแผนไอเดียประชาชน" list-tab actions:
 * สถานะพิจารณา / ปักธง / โน้ต).
 *
 * CLAUDE.md compliance:
 *  - §17.2 ADVISORY ONLY — this row gates NOTHING. It never writes
 *    `tracking_status`, never touches a workflow transition, ownership, or
 *    permission. It is a decision-support annotation, not a workflow status.
 *  - §17.3 ISOLATION — `citizen_planning_*` namespace. NO FK into any
 *    project-owning table. `ideaId` references `citizen_post.id` BY VALUE
 *    (plain uuid, no FK). The actor is referenced by WorkHistory UUID WITHOUT
 *    referential integrity (`owner_work_history_id` is a plain uuid, no FK).
 *  - Status Naming Constraint — `triageStatus` values
 *    (unreviewed / reviewing / agenda / parked) are DELIBERATELY distinct from
 *    the 8 canonical workflow statuses and the reserved `Revision` name. This
 *    is an executive planning vocabulary, NOT the workflow status machine.
 *
 * Scope: PRIVATE per executive (per WorkHistory). Every read/write is keyed by
 * the caller's current WorkHistory id — one executive never sees another's
 * planning state (round-1 scope; team-shared boards are a later round).
 */
export type CitizenPlanningTriageStatus =
  | 'unreviewed'
  | 'reviewing'
  | 'agenda'
  | 'parked';

@Entity('citizen_planning_entries')
@Index('uq_citizen_planning_owner_idea', ['ownerWorkHistoryId', 'ideaId'], {
  unique: true,
})
export class CitizenPlanningEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The executive's current WorkHistory id (§17.3 — plain uuid, no FK). */
  @Column({ name: 'owner_work_history_id', type: 'uuid' })
  ownerWorkHistoryId: string;

  /** citizen_post.id referenced BY VALUE (§17.3 — plain uuid, no FK). */
  @Column({ name: 'idea_id', type: 'uuid' })
  ideaId: string;

  @Column({
    name: 'triage_status',
    type: 'enum',
    enum: ['unreviewed', 'reviewing', 'agenda', 'parked'],
    enumName: 'citizen_planning_triage_status',
    default: 'unreviewed',
  })
  triageStatus: CitizenPlanningTriageStatus;

  @Column({ name: 'is_flagged', type: 'boolean', default: false })
  isFlagged: boolean;

  /** Executive-authored note (NOT citizen text). Null = no note. */
  @Column({ name: 'note', type: 'text', nullable: true })
  note: string | null;

  /**
   * Executive-authored effort / feasibility band for the Value×Effort matrix:
   * 1 = ทำง่าย/พร้อม, 2 = ปานกลาง, 3 = ยาก/ต้องเตรียม. Null = ยังไม่ให้คะแนน —
   * the idea has no x-position in the matrix (rendered in the "unscored" tray).
   * §17.2 advisory, per-executive (same scope as note/flag); engagement data
   * cannot express effort, so this MUST be a human judgment, never derived.
   */
  @Column({ name: 'effort_score', type: 'smallint', nullable: true })
  effortScore: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
