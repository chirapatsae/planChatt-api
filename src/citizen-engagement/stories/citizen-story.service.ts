import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { join } from 'path';
import { DataSource, EntityManager, In, IsNull, MoreThan, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenStory } from '../entities/citizen-story.entity';
import {
  StoryDto,
  StoryGroupDto,
} from '../dto/citizen-story-response.dto';
import {
  readImageDimensions,
  stripImageMetadata,
} from '../media/image-metadata.util';
import { CitizenStorageService } from '../media/citizen-storage.service';
import { CitizenMediaModerationService } from '../media/citizen-media-moderation.service';

/** Same media gate as citizen-media (reused, not re-invented). */
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png']);
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
// W-M1 decompression-bomb caps — same as the post-media path
// (citizen-media.service). A 5 MB file can still decode to a huge canvas.
const MAX_DIM = 10000;
const MAX_PIXELS = 40_000_000;
const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/** Stories live for 24h from creation. */
const STORY_TTL_MS = 24 * 60 * 60 * 1000;

/** On-disk base for story bytes (the citizen-stories sibling of citizen-media). */
const STORY_STORAGE_BASE = 'uploads/citizen-stories';

/** The public URL path served by CitizenStoryController GET :id/image. */
const STORY_IMAGE_URL_PREFIX = '/api/v1/citizen-engagement/stories/';

/** Minimal multer-file shape consumed by create (memory storage → buffer present). */
export interface CitizenStoryUploadFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

/**
 * CitizenStoryService — ephemeral 24-hour citizen stories (W-GATE-3).
 *
 * §17.3 isolation: touches ONLY `citizen_*` tables; audit goes EXCLUSIVELY to
 * `citizen_audit_logs`. Bytes live behind the swappable `CitizenStorageService`
 * under `uploads/citizen-stories/<DD-MM-YYYY>/`.
 *
 * PRIVACY (plan D10): every uploaded image is run through `stripImageMetadata`
 * BEFORE it is persisted — GPS/EXIF can NEVER reach the served file (the same
 * privacy proof as citizen-media).
 *
 * §17.2 advisory: stories write NOTHING to tracking_status / ai_*; they gate
 * no workflow transition.
 */
@Injectable()
export class CitizenStoryService {
  constructor(
    @InjectRepository(CitizenStory)
    private readonly storyRepo: Repository<CitizenStory>,
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    private readonly storage: CitizenStorageService,
    private readonly dataSource: DataSource,
    private readonly moderation: CitizenMediaModerationService,
  ) {}

  /** Build the public image URL for a story id (single source of truth for the prefix). */
  static imageUrlFor(id: string): string {
    return `${STORY_IMAGE_URL_PREFIX}${id}/image`;
  }

  /**
   * Validate → strip → store → insert row (expires_at = now + 24h) → audit.
   * Returns the new story DTO.
   */
  async create(
    identityId: string,
    fileBuffer: Buffer,
    mimetype: string,
    caption?: string,
  ): Promise<StoryDto> {
    const size = fileBuffer?.length ?? 0;
    if (
      !fileBuffer ||
      !ACCEPTED_TYPES.has(mimetype) ||
      size > MAX_SIZE_BYTES
    ) {
      throw new BadRequestException('CITIZEN_STORY_INVALID');
    }

    const trimmedCaption = caption?.trim() ? caption.trim() : null;
    if (trimmedCaption !== null && trimmedCaption.length > 280) {
      throw new BadRequestException('CITIZEN_STORY_CAPTION_TOO_LONG');
    }

    // W-M1: decompression-bomb dimension guard (stories are a second public
    // image-upload path — it MUST share the post-media protections or it is a
    // moderation-bypass hole). Parse failure → the existing INVALID.
    let dims: { width: number; height: number };
    try {
      dims = readImageDimensions(fileBuffer, mimetype);
    } catch {
      throw new BadRequestException('CITIZEN_STORY_INVALID');
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
      clean = stripImageMetadata(fileBuffer, mimetype);
    } catch {
      throw new BadRequestException('CITIZEN_STORY_INVALID');
    }

    // W-M1: content-moderation seam (fail-closed when a provider is configured)
    // on the cleaned bytes that will actually be stored — same as post media.
    await this.moderation.assertAllowed(clean, mimetype);

    const key = this.keyForStory(EXT_BY_TYPE[mimetype]);
    await this.storage.save(key, clean);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + STORY_TTL_MS);

    try {
      return await this.dataSource.transaction(async (em) => {
        const story = em.getRepository(CitizenStory).create({
          authorIdentityId: identityId,
          imagePath: key,
          caption: trimmedCaption,
          expiresAt,
        });
        const saved = await em.getRepository(CitizenStory).save(story);

        await this.writeAudit(em, identityId, 'story.create', 'story', saved.id, {
          contentType: mimetype,
          byteSize: clean.length,
          expiresAt: expiresAt.toISOString(),
        });

        return this.toStoryDto(saved);
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
   * The PUBLIC active feed: every non-expired (`expires_at > now`), not
   * soft-deleted story, grouped by author. The author block carries ONLY
   * `id` + `displayAlias` (alias-only select — no PII can leak).
   */
  async listActive(): Promise<StoryGroupDto[]> {
    const now = new Date();
    const stories = await this.storyRepo.find({
      where: { expiresAt: MoreThan(now), deletedAt: IsNull() },
      order: { authorIdentityId: 'ASC', createdAt: 'ASC' },
    });

    if (stories.length === 0) {
      return [];
    }

    // Alias-only identity load (id + displayAlias ONLY — never *_enc / *_hash).
    const authorIds = [...new Set(stories.map((s) => s.authorIdentityId))];
    const authors = await this.identityRepo.find({
      // Only ACTIVE authors — a blocked/erased citizen's stories must not
      // surface (TypeORM `find` already excludes soft-deleted identity rows).
      where: { id: In(authorIds), status: 'active' },
      select: { id: true, displayAlias: true },
    });
    const aliasById = new Map(authors.map((a) => [a.id, a.displayAlias]));

    // Group preserving first-seen author order (stories already sorted).
    const groups = new Map<string, StoryGroupDto>();
    for (const story of stories) {
      // Skip stories whose author is no longer active (excluded above).
      if (!aliasById.has(story.authorIdentityId)) continue;
      let group = groups.get(story.authorIdentityId);
      if (!group) {
        group = {
          author: {
            id: story.authorIdentityId,
            displayAlias: aliasById.get(story.authorIdentityId) ?? '',
          },
          stories: [],
        };
        groups.set(story.authorIdentityId, group);
      }
      group.stories.push(this.toStoryDto(story));
    }

    return [...groups.values()];
  }

  /**
   * Serve the bytes for a NON-EXPIRED, not-soft-deleted story. An expired or
   * deleted story → 404 (the image-serve guard: ephemeral means the URL stops
   * working past the 24h window).
   */
  async getImage(id: string): Promise<{ contentType: string; buffer: Buffer }> {
    const now = new Date();
    const story = await this.storyRepo.findOne({
      where: { id, expiresAt: MoreThan(now), deletedAt: IsNull() },
    });
    if (!story) {
      throw new NotFoundException('CITIZEN_STORY_NOT_FOUND');
    }
    const contentType = story.imagePath.endsWith('.png')
      ? 'image/png'
      : 'image/jpeg';
    const buffer = await this.storage.read(story.imagePath);
    return { contentType, buffer };
  }

  /**
   * Owner-scoped soft-delete. A missing story → 404; a story owned by someone
   * else → 403. The bytes are left on disk (the row is the source of truth);
   * the active feed + image-serve already exclude soft-deleted rows.
   */
  async removeOwn(identityId: string, storyId: string): Promise<void> {
    const story = await this.storyRepo.findOne({
      where: { id: storyId, deletedAt: IsNull() },
    });
    if (!story) {
      throw new NotFoundException('CITIZEN_STORY_NOT_FOUND');
    }
    if (story.authorIdentityId !== identityId) {
      throw new ForbiddenException('CITIZEN_STORY_NOT_OWNER');
    }

    await this.dataSource.transaction(async (em) => {
      await em.getRepository(CitizenStory).softDelete(storyId);
      await this.writeAudit(em, identityId, 'story.delete', 'story', storyId, {});
    });
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a fresh storage key under the citizen-stories convention
   * `uploads/citizen-stories/<DD-MM-YYYY>/<uuid>.<ext>` — the story sibling of
   * the citizen-media path. The key IS the opaque relative path passed to the
   * swappable storage service.
   */
  private keyForStory(ext: string): string {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = String(now.getFullYear());
    const dateSegment = `${day}-${month}-${year}`;
    return join(STORY_STORAGE_BASE, dateSegment, `${uuidv4()}.${ext}`);
  }

  private toStoryDto(story: CitizenStory): StoryDto {
    return {
      id: story.id,
      imageUrl: CitizenStoryService.imageUrlFor(story.id),
      caption: story.caption,
      createdAt: story.createdAt.toISOString(),
      expiresAt: story.expiresAt.toISOString(),
    };
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
