import { Injectable } from '@nestjs/common';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { v4 as uuidv4 } from 'uuid';

/**
 * CitizenStorageService — the SWAPPABLE blob-storage seam (plan D10 / Q-COMM-3).
 *
 * v1 impl = LOCAL DISK under `uploads/citizen-media/<DD-MM-YYYY>/<uuid>.<ext>`,
 * mirroring the `attachment-*` `uploads/<DD-MM-YYYY>` convention. ALL disk-path
 * logic is isolated in this one class so an S3 impl is a drop-in replacement
 * later — callers only ever see the opaque `key` string, never a filesystem
 * path. Swap the three method bodies (save / read / remove) + `keyFor` and the
 * rest of the media stack is unchanged.
 *
 * §17.3 isolation: storage holds raw bytes only; it touches NO entity / DB /
 * project table.
 */
@Injectable()
export class CitizenStorageService {
  private readonly baseDir = 'uploads/citizen-media';

  /**
   * Build a fresh storage key for a new upload. The key IS the relative disk
   * path under the swappable convention — opaque to callers. An S3 impl would
   * return an S3 object key here with no caller change.
   */
  keyFor(ext: string): string {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = String(now.getFullYear());
    const dateSegment = `${day}-${month}-${year}`;
    return join(this.baseDir, dateSegment, `${uuidv4()}.${ext}`);
  }

  async save(key: string, buf: Buffer): Promise<void> {
    await mkdir(dirname(key), { recursive: true });
    await writeFile(key, buf);
  }

  async read(key: string): Promise<Buffer> {
    return readFile(key);
  }

  async remove(key: string): Promise<void> {
    await unlink(key);
  }
}
