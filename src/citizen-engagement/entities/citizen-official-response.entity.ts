import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { CitizenPost } from './citizen-post.entity';

/**
 * citizen_official_response — the OFFICIAL-RESPONSE loop (C4, plan D12).
 *
 * An INTERNAL staff member who has been GRANTED the `respond` capability posts
 * an official answer to a citizen post; the citizen sees it (public read) and
 * is notified. This is the FIRST feature that gates on the INTERNAL staff
 * identity (JwtAuthGuard) rather than the citizen identity.
 *
 * §17.3 isolation (NON-NEGOTIABLE): the internal responder is stored as a
 * PLAIN uuid (`responder_work_history_id` / `responder_user_id`, NO FK into
 * `work_history` / `users`) plus SNAPSHOT strings (`responder_display_name`,
 * `responder_agency_name`). The ONLY relation/FK is `post_id → citizen_post`
 * (citizen_* → citizen_*). Responses expose ONLY the snapshot display/agency
 * name — never a national id / `*_enc`. Official response is ADVISORY (§17.2):
 * it creates no project and changes no workflow status.
 */
@Entity('citizen_official_response')
@Index('ix_citizen_official_response_post', ['postId', 'createdAt'])
export class CitizenOfficialResponse {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'post_id', type: 'uuid' })
  postId: string;

  @ManyToOne(() => CitizenPost)
  @JoinColumn({ name: 'post_id' })
  post: CitizenPost;

  /** Internal responder WorkHistory uuid — PLAIN, NO FK (§17.3). */
  @Column({ name: 'responder_work_history_id', type: 'uuid' })
  responderWorkHistoryId: string;

  /** Internal responder User uuid — PLAIN, NO FK (§17.3). */
  @Column({ name: 'responder_user_id', type: 'uuid' })
  responderUserId: string;

  /** Snapshot of the responder's display name at response time (§17.3). */
  @Column({ name: 'responder_display_name', type: 'varchar', length: 128 })
  responderDisplayName: string;

  /** Snapshot of the responder's agency name at response time (nullable). */
  @Column({ name: 'responder_agency_name', type: 'varchar', length: 255, nullable: true })
  responderAgencyName: string | null;

  @Column({ name: 'body', type: 'text' })
  body: string;

  /**
   * W-G2: issue-handling status lifecycle — `received` | `in_progress` |
   * `resolved`. Set to `received` at create time and advanced forward-or-same
   * by a respond-granted staff member. CHECK `ck_citizen_official_response_status`
   * is enforced via the bootstrap-migrations catalog (synchronize adds the
   * column but never the CHECK) + the W-G2 record migration. §17.2 advisory —
   * this is the citizen issue-handling state, NOT a project workflow status.
   */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'received' })
  status: string;

  /** W-G2: when `status` was last advanced (NULL until the first transition). */
  @Column({ name: 'status_updated_at', type: 'timestamptz', nullable: true })
  statusUpdatedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
