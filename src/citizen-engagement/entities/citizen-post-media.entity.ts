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
import { CitizenPost } from './citizen-post.entity';

/**
 * citizen_post_media — a privacy-stripped photo attached to a citizen post.
 *
 * C2 v1 (plan D10): images are uploaded UNATTACHED (`post_id` NULL), stripped of
 * EXIF/GPS metadata BEFORE persistence (see image-metadata.util.ts), then
 * single-attached to a post by its owner inside the post-create transaction.
 *
 * §17.3 isolation: the ONLY FKs are `post_id → citizen_post` and
 * `owner_identity_id → citizen_identities` (citizen_* → citizen_*). The served
 * bytes are local-disk via the swappable `CitizenStorageService`; `storage_key`
 * is an opaque path, not a project FK. Zero FK into project / users /
 * work_history / tracking_status.
 */
@Entity('citizen_post_media')
@Index('ix_citizen_media_post', ['postId'])
@Index('ix_citizen_media_owner', ['ownerIdentityId'])
export class CitizenPostMedia {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** NULL until the media is attached to a post (single-attach, owner-only). */
  @Column({ name: 'post_id', type: 'uuid', nullable: true })
  postId: string | null;

  @ManyToOne(() => CitizenPost)
  @JoinColumn({ name: 'post_id' })
  post: CitizenPost | null;

  @Column({ name: 'owner_identity_id', type: 'uuid' })
  ownerIdentityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'owner_identity_id' })
  owner: CitizenIdentity;

  /** Opaque local-disk path (or future S3 key) — resolved by CitizenStorageService. */
  @Column({ name: 'storage_key', type: 'varchar', length: 255 })
  storageKey: string;

  @Column({ name: 'content_type', type: 'varchar', length: 32 })
  contentType: string;

  @Column({ name: 'byte_size', type: 'int' })
  byteSize: number;

  /** `ready|pending|rejected`. CHECK enforced in migration. v1 = 'ready' after strip. */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'ready' })
  status: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
