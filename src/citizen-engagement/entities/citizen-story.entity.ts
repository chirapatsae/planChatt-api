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

import { CitizenIdentity } from './citizen-identity.entity';

/**
 * citizen_story — an EPHEMERAL 24-hour citizen story (W-GATE-3).
 *
 * A story is a single privacy-stripped image (+ optional caption) that is
 * visible for 24 hours from creation, then automatically drops out of the
 * active feed once `expires_at <= now()`. There is NO hard delete on expiry —
 * the row lingers (soft-delete via `removeOwn` only) but the read paths refuse
 * to serve an expired story, so it is invisible past the window.
 *
 * PRIVACY (plan D10): the image is run through `stripImageMetadata` BEFORE it
 * is persisted, exactly like `citizen_post_media` — GPS/EXIF can NEVER reach
 * the served file. Bytes live behind the swappable `CitizenStorageService`;
 * `image_path` is an opaque storage key, not a project FK.
 *
 * §17.3 isolation: the ONLY FK is `author_identity_id → citizen_identities`
 * (citizen_* → citizen_*). Zero FK into project / users / work_history /
 * tracking_status. Audit goes EXCLUSIVELY to `citizen_audit_logs`.
 */
@Entity('citizen_story')
@Index('ix_citizen_story_author_expires', ['authorIdentityId', 'expiresAt'])
@Index('ix_citizen_story_expires', ['expiresAt'])
export class CitizenStory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'author_identity_id', type: 'uuid' })
  authorIdentityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'author_identity_id' })
  author: CitizenIdentity;

  /** Opaque local-disk path (or future S3 key) — resolved by CitizenStorageService. */
  @Column({ name: 'image_path', type: 'varchar', length: 255 })
  imagePath: string;

  @Column({ name: 'caption', type: 'varchar', length: 280, nullable: true })
  caption: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** `created_at + 24h`. A story is active while `expires_at > now()`. */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
