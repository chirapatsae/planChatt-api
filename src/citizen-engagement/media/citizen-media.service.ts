import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { CitizenPostMedia } from '../entities/citizen-post-media.entity';
import { readImageDimensions, stripImageMetadata } from './image-metadata.util';
import { CitizenStorageService } from './citizen-storage.service';
import { CitizenMediaModerationService } from './citizen-media-moderation.service';

/**
 * Accepted upload content-types — IMAGE-ONLY by design.
 *
 * VIDEO IS FAIL-CLOSED (W-M1). A `video/*` (or any non-listed) content-type
 * reaching `upload` is rejected with the existing `400 CITIZEN_MEDIA_INVALID`.
 * Video is intentionally NOT accepted in v1 because two pieces of infrastructure
 * do not yet exist:
 *   (a) a transcoding pipeline (we forbid heavyweight media libs; raw-byte
 *       handling cannot safely normalise arbitrary video containers), and
 *   (b) a CSAM / NSFW detection provider wired through
 *       `CitizenMediaModerationService`.
 * Only once BOTH are provisioned may `video/mp4` (etc.) be added to a SEPARATE
 * accepted set, gated behind a `CITIZEN_VIDEO_ENABLED` env flag, with every
 * uploaded video routed through `assertAllowed` exactly like images. Until then
 * there is NO unmoderated video path.
 */
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png']);
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
/** Decompression-bomb dimension caps (W-M1). */
const MAX_DIM = 10000;
const MAX_PIXELS = 40_000_000;
const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/** The public URL path served by CitizenMediaController GET :id. */
const MEDIA_URL_PREFIX = '/api/v1/citizen-engagement/media/';

/** Minimal multer-file shape consumed by upload (memory storage → buffer present). */
export interface CitizenMediaUploadFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

/**
 * CitizenMediaService — privacy-safe photo media for citizen posts (C2 v1).
 *
 * §17.3 isolation: touches ONLY `citizen_*` tables; audit goes EXCLUSIVELY to
 * `citizen_audit_logs`. Bytes live behind the swappable `CitizenStorageService`.
 *
 * PRIVACY (plan D10): every uploaded image is run through `stripImageMetadata`
 * BEFORE it is persisted — GPS/EXIF can never reach the served file.
 */
@Injectable()
export class CitizenMediaService {
  constructor(
    @InjectRepository(CitizenPostMedia)
    private readonly mediaRepo: Repository<CitizenPostMedia>,
    private readonly storage: CitizenStorageService,
    private readonly dataSource: DataSource,
    private readonly moderation: CitizenMediaModerationService,
  ) {}

  /** Build the public URL for a media id (single source of truth for the prefix). */
  static urlFor(id: string): string {
    return MEDIA_URL_PREFIX + id;
  }

  /**
   * Validate → strip → store → insert row (status 'ready') → audit.
   * Returns the new media id + its public URL.
   */
  async upload(
    identityId: string,
    file: CitizenMediaUploadFile,
  ): Promise<{ id: string; url: string }> {
    // VIDEO (and any non-image type) is fail-closed here — see ACCEPTED_TYPES.
    if (
      !file ||
      !ACCEPTED_TYPES.has(file.mimetype) ||
      file.size > MAX_SIZE_BYTES
    ) {
      throw new BadRequestException('CITIZEN_MEDIA_INVALID');
    }

    // DECOMPRESSION-BOMB GUARD (W-M1): inspect the declared header dimensions
    // BEFORE strip/persist. A tiny file can declare enormous dimensions and
    // blow up any downstream renderer. A parse failure → existing 400 INVALID;
    // an oversized image → 400 DIMENSIONS.
    let dims: { width: number; height: number };
    try {
      dims = readImageDimensions(file.buffer, file.mimetype);
    } catch {
      throw new BadRequestException('CITIZEN_MEDIA_INVALID');
    }
    if (
      dims.width > MAX_DIM ||
      dims.height > MAX_DIM ||
      dims.width * dims.height > MAX_PIXELS
    ) {
      throw new BadRequestException('CITIZEN_MEDIA_DIMENSIONS');
    }

    // PRIVACY strip BEFORE persistence. A malformed image throws → 400.
    let clean: Buffer;
    try {
      clean = stripImageMetadata(file.buffer, file.mimetype);
    } catch {
      throw new BadRequestException('CITIZEN_MEDIA_INVALID');
    }

    // CONTENT-MODERATION SEAM (W-M1): moderate the CLEANED bytes (the bytes that
    // will actually be stored/served), AFTER the strip, BEFORE storage.save +
    // persist. Allowed → continue; deny/provider-failure (when configured) →
    // 422 CITIZEN_MEDIA_REJECTED (fail-closed). `moderated` records which path
    // ran for the audit detail. The bytes go ONLY to the provider (never logged).
    const moderated = await this.moderation.assertAllowed(clean, file.mimetype);

    // NSFW seam (Q-COMM-3) — NO-OP in v1, returns 'ready'.
    const status = await this.maybeScan();

    const key = this.storage.keyFor(EXT_BY_TYPE[file.mimetype]);
    await this.storage.save(key, clean);

    try {
      return await this.dataSource.transaction(async (em) => {
        const media = em.getRepository(CitizenPostMedia).create({
          ownerIdentityId: identityId,
          storageKey: key,
          contentType: file.mimetype,
          byteSize: clean.length,
          status,
          postId: null,
          sortOrder: 0,
        });
        const saved = await em.getRepository(CitizenPostMedia).save(media);

        await this.writeAudit(em, identityId, 'media.upload', 'media', saved.id, {
          contentType: saved.contentType,
          byteSize: saved.byteSize,
          moderated,
        });

        return { id: saved.id, url: CitizenMediaService.urlFor(saved.id) };
      });
    } catch (err) {
      // The row never committed — remove the orphaned (already stripped) blob so
      // no PII-residue file lingers with no DB pointer. Best-effort; never mask
      // the original failure.
      await this.storage.remove(key).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Load + read the bytes for a served media id. 404 unless the media is `ready`,
   * not soft-deleted, AND attached to a VISIBLE, non-deleted post — so hiding /
   * removing / soft-deleting a post also hides its photos (no guessable-URL
   * bypass of moderation). Unattached staging media (postId null) is never
   * served publicly; the composer previews it client-side via an object URL.
   */
  async serve(id: string): Promise<{ contentType: string; buffer: Buffer }> {
    const media = await this.mediaRepo.findOne({
      where: { id, status: 'ready', deletedAt: IsNull() },
      relations: ['post'],
    });
    if (
      !media ||
      !media.post ||
      media.post.moderationState !== 'visible' ||
      media.post.deletedAt !== null
    ) {
      throw new NotFoundException('CITIZEN_MEDIA_NOT_FOUND');
    }
    const buffer = await this.storage.read(media.storageKey);
    return { contentType: media.contentType, buffer };
  }

  /**
   * Attach the caller's unattached media rows to a freshly-created post, in
   * order. REJECTS a media id that is missing, owned by someone else, or already
   * attached (`postId !== null`) — enforcing ownership + single-attach.
   *
   * Runs inside the post-create transaction (shares the caller's EntityManager).
   */
  async attachMediaToPost(
    em: EntityManager,
    identityId: string,
    postId: string,
    mediaIds: string[],
  ): Promise<void> {
    for (let index = 0; index < mediaIds.length; index++) {
      const mediaId = mediaIds[index];
      const media = await em.getRepository(CitizenPostMedia).findOne({
        where: { id: mediaId, deletedAt: IsNull() },
      });
      if (
        !media ||
        media.ownerIdentityId !== identityId ||
        media.postId !== null
      ) {
        throw new BadRequestException('CITIZEN_MEDIA_NOT_ATTACHABLE');
      }
      media.postId = postId;
      media.sortOrder = index;
      await em.getRepository(CitizenPostMedia).save(media);
    }
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /**
   * NSFW scan seam (plan D10 / Q-COMM-3). v1 is a NO-OP that marks every upload
   * 'ready' after the privacy strip. The real provider (cloud vision / on-prem
   * model) plugs in HERE — return 'rejected' or 'pending' to gate a flagged
   * image without touching any caller.
   */
  private async maybeScan(): Promise<string> {
    return 'ready';
  }

  /** Insert the isolated audit row (§17.3 — NEVER tracking_status). */
  private async writeAudit(
    em: EntityManager,
    identityId: string,
    action: string,
    targetKind: string,
    targetId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const row = em.getRepository(CitizenAuditLog).create({
      actorKind: 'citizen',
      actorId: identityId,
      action,
      targetKind,
      targetId,
      detail,
    });
    await em.getRepository(CitizenAuditLog).save(row);
  }
}
