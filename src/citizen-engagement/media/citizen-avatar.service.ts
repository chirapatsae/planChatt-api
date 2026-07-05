import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenStorageService } from './citizen-storage.service';
import { stripImageMetadata } from './image-metadata.util';

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png']);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * CitizenAvatarService — the citizen profile-photo file lifecycle (community
 * avatars, 2026-07). Reuses the SAME swappable storage seam + EXIF-strip that
 * post / chat images use, so an S3 swap is a drop-in and every uploaded byte is
 * privacy-scrubbed (no embedded GPS / device metadata) per §17.3 / PDPA.
 *
 * Upload replaces any prior photo (old blob best-effort removed). The identity
 * row holds ONLY the opaque storage key (`avatarPath`), never a raw disk path.
 */
@Injectable()
export class CitizenAvatarService {
  constructor(
    @InjectRepository(CitizenIdentity)
    private readonly identities: Repository<CitizenIdentity>,
    private readonly storage: CitizenStorageService,
  ) {}

  /** Store a new profile photo (EXIF-stripped) for the caller, replacing any old. */
  async upload(identityId: string, file: Express.Multer.File): Promise<void> {
    if (!file || !file.buffer?.length) {
      throw new BadRequestException('CITIZEN_AVATAR_FILE_REQUIRED');
    }
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      throw new BadRequestException('CITIZEN_AVATAR_TYPE_INVALID');
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('CITIZEN_AVATAR_TOO_LARGE');
    }
    const identity = await this.identities.findOne({
      where: { id: identityId, deletedAt: IsNull() },
    });
    if (!identity) throw new NotFoundException('CITIZEN_IDENTITY_NOT_FOUND');

    // PDPA — strip EXIF/metadata before the bytes ever hit storage. Garbled
    // input throws → surfaced as 400.
    let stripped: Buffer;
    try {
      stripped = stripImageMetadata(file.buffer, file.mimetype);
    } catch {
      throw new BadRequestException('CITIZEN_AVATAR_IMAGE_INVALID');
    }
    const ext = file.mimetype === 'image/png' ? 'png' : 'jpg';
    const key = this.storage.keyFor(ext);
    await this.storage.save(key, stripped);

    const oldKey = identity.avatarPath;
    identity.avatarPath = key;
    await this.identities.save(identity);
    if (oldKey) {
      // Best-effort — a leaked orphan blob is harmless; never fail the upload.
      await this.storage.remove(oldKey).catch(() => undefined);
    }
  }

  /** Clear the caller's profile photo (back to the gradient+initial). */
  async remove(identityId: string): Promise<void> {
    const identity = await this.identities.findOne({
      where: { id: identityId, deletedAt: IsNull() },
    });
    if (!identity) throw new NotFoundException('CITIZEN_IDENTITY_NOT_FOUND');
    const oldKey = identity.avatarPath;
    if (!oldKey) return;
    identity.avatarPath = null;
    await this.identities.save(identity);
    await this.storage.remove(oldKey).catch(() => undefined);
  }

  /** Public read — the raw bytes + content type, or 404 when no photo exists. */
  async serve(identityId: string): Promise<{ buffer: Buffer; contentType: string }> {
    const identity = await this.identities.findOne({
      where: { id: identityId, deletedAt: IsNull() },
      select: { id: true, avatarPath: true },
    });
    if (!identity?.avatarPath) throw new NotFoundException('CITIZEN_AVATAR_NOT_FOUND');
    const buffer = await this.storage.read(identity.avatarPath);
    const contentType = identity.avatarPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return { buffer, contentType };
  }
}
