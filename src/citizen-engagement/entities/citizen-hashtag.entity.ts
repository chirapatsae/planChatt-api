import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * citizen_hashtag — a normalized hashtag dictionary row (W-S4).
 *
 * `tag` is the canonical, normalized form of a `#tag` parsed from a post body:
 * NFC-normalized, leading `#` stripped, lowercased. The post→tag links live in
 * `citizen_post_hashtag`; this table is the deduplicated tag dictionary so the
 * trending query groups on a stable `hashtag_id` and the tag-search page can
 * resolve a canonical tag in O(1) via the unique `tag`.
 *
 * §17.3 isolation: this table has NO foreign key at all — it is a pure
 * dictionary keyed by its own uuid. Zero foreign key into any project table /
 * users / work_history / tracking_status. §17.2 ADVISORY — a hashtag drives no
 * workflow; trending is presentation-only.
 */
@Entity('citizen_hashtag')
// Canonical lookup + dedup: at most one row per normalized tag.
@Index('uq_citizen_hashtag_tag', ['tag'], { unique: true })
export class CitizenHashtag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * The normalized tag (NFC, no leading `#`, lowercased). The verbatim `#tag`
   * surface form is NOT stored — only the canonical key, so `#สวน` and `#สวน`
   * (different NFC forms) and `#Park` / `#park` collapse to one dictionary row.
   */
  @Column({ name: 'tag', type: 'varchar', length: 140 })
  tag: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
