import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateMyPreferencesDto } from './dto/update-my-preferences.dto';
import {
  decryption,
  encryption,
  hashCitizenId,
  hashEmail,
  hashPhone,
} from 'src/util/encryption.util';
import { handleException } from 'src/util/handleException';
import { AiUsageQuotasService } from 'src/ai-usage-quotas/ai-usage-quotas.service';
import { StorageService } from 'src/storage/storage.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly aiUsageQuotasService: AiUsageQuotasService,
    private readonly storageService: StorageService,
  ) { }

  /**
   * W89 — Decrypts PII columns (citizenId, email, phone) on a User entity in
   * place. Use at every read-path response boundary so callers always see
   * plaintext.
   *
   * If decryption throws (corrupted ciphertext, wrong key, etc.) the field
   * is set to `null` rather than crashing the request — only the error
   * class name is logged, never the ciphertext or the partial plaintext.
   * W83 logger discipline applies.
   *
   * W89B — Made `public` so downstream services that read the User entity
   * via TypeORM relations (EventsService, AnnouncementsService, ...) can
   * decrypt at THEIR response boundary without bypassing UsersService and
   * without duplicating the decryption util.
   *
   * This method is SAFE to call multiple times on the same entity — the
   * `decryption()` util internally tolerates strings that no longer match
   * the `iv:ciphertext` shape (the value will be re-set to itself or
   * `null` on a parse error). Callers MAY guard with the W89 ciphertext
   * heuristic if they want to skip the work entirely on already-decrypted
   * entities, but a redundant call is not a correctness hazard.
   */
  async decryptUserPii(user: User): Promise<User> {
    if (!user) return user;

    if (user.citizenId && UsersService.looksLikeCiphertext(user.citizenId)) {
      try {
        user.citizenId = await decryption(user.citizenId);
      } catch (error) {
        this.logger.error(
          `decryptUserPii citizenId failed: ${error?.constructor?.name ?? 'UnknownError'}`,
        );
        user.citizenId = null as unknown as string;
      }
    }

    if (user.email && UsersService.looksLikeCiphertext(user.email)) {
      try {
        user.email = await decryption(user.email);
      } catch (error) {
        this.logger.error(
          `decryptUserPii email failed: ${error?.constructor?.name ?? 'UnknownError'}`,
        );
        user.email = undefined;
      }
    }

    if (user.phone && UsersService.looksLikeCiphertext(user.phone)) {
      try {
        user.phone = await decryption(user.phone);
      } catch (error) {
        this.logger.error(
          `decryptUserPii phone failed: ${error?.constructor?.name ?? 'UnknownError'}`,
        );
        user.phone = undefined;
      }
    }

    return user;
  }

  /**
   * W89B — Ciphertext heuristic. Mirrors `AuthService.looksLikeCiphertext`.
   * Used to guard decryption so `decryptUserPii` is safe to call multiple
   * times on the same User entity (downstream services may decrypt at
   * their response boundary without knowing whether someone already did).
   *
   * Plaintext emails contain `@` and plaintext phones are digit-only —
   * neither matches the `iv:ciphertext` shape (two hex blocks separated
   * by a colon). Already-decrypted values are short-circuited.
   */
  private static looksLikeCiphertext(value: string): boolean {
    if (typeof value !== 'string' || value.length === 0) return false;
    return /^[0-9a-f]{16,}:[0-9a-f]{16,}$/i.test(value);
  }

  /**
   * W89 — Encrypts + hashes email/phone from an inbound DTO onto a User
   * partial. Caller is responsible for citizenId (handled separately due
   * to its preCalculatedHash flow). Mutates `target` in place.
   *
   * Empty strings are treated as "not provided" — only truthy DTO values
   * trigger encryption.
   */
  private async encryptUserPiiFromDto(
    target: Partial<User>,
    dto: { email?: string; phone?: string },
  ): Promise<void> {
    if (dto.email) {
      target.email = await encryption(dto.email);
      target.emailHash = hashEmail(dto.email);
    }
    if (dto.phone) {
      target.phone = await encryption(dto.phone);
      target.phoneHash = hashPhone(dto.phone);
    }
  }

  /**
   * Creates a new user. Unique constraints are handled by the database.
   */
  async create(createUserDto: CreateUserDto, preCalculatedHash?: string): Promise<User> {
    try {
      // Use pre-calculated hash if provided, otherwise calculate new one
      const hashedCid = preCalculatedHash || hashCitizenId(createUserDto.citizenId);

      // Check if user with this hash already exists before creating
      const existingUser = await this.userRepository.findOne({
        where: { citizenIdHash: hashedCid }
      });

      if (existingUser) {
        this.logger.warn(`User with hash ${hashedCid} already exists. Returning existing user.`);
        return await this.decryptUserPii(existingUser);
      }

      const encryptedCid = await encryption(createUserDto.citizenId);

      // Build the row with citizenId already encrypted; email/phone are
      // applied via the PII helper so encryption + hash stay in lockstep.
      const { email: _dtoEmail, phone: _dtoPhone, ...rest } = createUserDto;
      const userPayload: Partial<User> = {
        ...rest,
        citizenId: encryptedCid,
        citizenIdHash: hashedCid,
      };
      await this.encryptUserPiiFromDto(userPayload, createUserDto);

      const user = this.userRepository.create(userPayload);
      const savedUser = await this.userRepository.save(user);

      // Assign default AI quota
      await this.aiUsageQuotasService.createDefaultQuota(savedUser.id);

      return await this.decryptUserPii(savedUser);
    } catch (error) {
      // W83 — DO NOT JSON.stringify the DTO; it carries plaintext PII.
      // Log only the error class so we keep observability without leaking.
      this.logger.error(
        `Failed to create user: ${error?.constructor?.name ?? 'UnknownError'}`,
        error?.stack,
      );
      handleException(this.logger, error);
    }
  }

  /**
   * Retrieves all users. Decrypts citizenId / email / phone for every row
   * so callers always see plaintext (§17 advisory; W89 contract).
   *
   * Performance note: decryption runs sequentially per row. For large user
   * tables this should switch to paginated reads + lazy decrypt at the
   * response shaping layer. For current scale this is acceptable.
   */
  async findAll(): Promise<User[]> {
    try {
      const users = await this.userRepository.find({
        relations: {
          workHistory: {
            amphoe: true,
            localAdministrativeOrganization: true,
            workHistoryResponsibleAmphoe: {
              amphoe: true,
            },
            governmentAgencies: true,
          },
          aiUsageQuota: true,
        },
      });

      for (const user of users) {
        await this.decryptUserPii(user);
      }
      return users;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Finds a single user by ID and decrypts their sensitive data.
   */
  async findOne(id: string): Promise<User> {
    try {
      const user = await this.userRepository.findOne({
        where: { id },
        relations: {
          workHistory: {
            amphoe: true,
            localAdministrativeOrganization: true,
            workHistoryResponsibleAmphoe: {
              amphoe: true,
            },
            governmentAgencies: true,
            role: true,
          },
          aiUsageQuota: {
            aiUsageLogs: true,
          },
        },
      });

      if (!user) {
        throw new NotFoundException(`User with ID ${id} not found`);
      }

      return await this.decryptUserPii(user);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Updates a user's details using the 'preload' pattern.
   *
   * W89 — when `dto.email` / `dto.phone` are provided we re-encrypt and
   * recompute the deterministic hash. When they are `undefined` we leave
   * the column untouched (TypeORM preload semantics).
   *
   * citizenId remains intentionally non-mutable here (kept commented-out
   * since pre-W89). If a future flow wants to mutate it, route through a
   * dedicated method that re-validates the hash uniqueness.
   */
  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    try {
      const { citizenId, email, phone, ...otherDetails } = updateUserDto;
      const updatePayload: Partial<User> = { ...otherDetails };

      // if (citizenId) {
      //   updatePayload['citizenId'] = await encryption(citizenId);
      //   updatePayload['citizenIdHash'] = hashCitizenId(citizenId);
      // }

      // Encrypt + hash email/phone only when the DTO carries them. Pass
      // through the helper so encrypt and hash never drift apart.
      await this.encryptUserPiiFromDto(updatePayload, { email, phone });

      // W95 — Reset-on-change: if the incoming DTO carries a new email AND
      // the deterministic hash differs from the row's stored emailHash,
      // force `emailVerifiedAt` back to NULL in the SAME UPDATE so the
      // reset is atomic with the email change.
      //
      // Comparison is hash-only — we MUST NOT decrypt the existing email
      // to test equality (W89 contract; W83 logger discipline). When the
      // user has no prior email_hash (first-time email set) we leave
      // emailVerifiedAt at its current default (NULL) implicitly — no
      // explicit override needed, but assigning NULL is harmless and
      // makes the intent obvious.
      if (email && updatePayload.emailHash) {
        const existing = await this.userRepository.findOne({
          where: { id },
          select: ['id', 'emailHash'],
        });
        if (existing && existing.emailHash !== updatePayload.emailHash) {
          updatePayload.emailVerifiedAt = null;
        }
      }

      const userToUpdate = await this.userRepository.preload({
        id,
        ...updatePayload,
      });

      if (!userToUpdate) {
        throw new NotFoundException(`User with ID ${id} not found to update`);
      }

      const savedUser = await this.userRepository.save(userToUpdate);
      return await this.decryptUserPii(savedUser);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * W95 — Idempotently mark a user's current email as verified.
   *
   * Single conditional UPDATE — `SET email_verified_at = NOW() WHERE id = $1
   * AND email_verified_at IS NULL`. Calling twice is a safe no-op (the
   * second call's WHERE clause matches zero rows and returns affected=0).
   *
   * This method is intentionally tolerant of "row no longer exists" — the
   * verify endpoint (W95-VERIFY-FLOW) may receive a click on a link whose
   * user has been soft-deleted between issuance and click. We log the
   * userId only (W83) and return cleanly rather than throwing.
   *
   * §4.1 — verification is integrity, NOT workflow authority. This call
   * does NOT touch tracking_status (§12) and does NOT gate any project
   * action.
   */
  async markEmailVerified(userId: string): Promise<void> {
    if (typeof userId !== 'string' || userId.length === 0) {
      return;
    }
    try {
      const result = await this.userRepository
        .createQueryBuilder()
        .update(User)
        .set({ emailVerifiedAt: () => 'NOW()' })
        .where('id = :id', { id: userId })
        .andWhere('email_verified_at IS NULL')
        .execute();

      // W83 — log userId only; never the email or hash.
      if (result.affected && result.affected > 0) {
        this.logger.log(`user.email-verified.marked userId=${userId}`);
      } else {
        this.logger.log(
          `user.email-verified.noop userId=${userId} (already verified or row missing)`,
        );
      }
    } catch (error) {
      // Tolerate "row missing" — log the error class only, don't throw.
      this.logger.error(
        `markEmailVerified failed: ${error?.constructor?.name ?? 'UnknownError'} userId=${userId}`,
      );
    }
  }

  /**
   * W89 — Lookup a user by their citizenId hash and return the entity with
   * PII decrypted. Used by the ThaID OAuth login flow which derives
   * `citizenIdHash` from the verified id_token claim and MUST NOT see
   * ciphertext on the User entity (otherwise the response payload would
   * leak `iv:ciphertext` to the frontend).
   *
   * The returned entity carries the relations the auth flow depends on
   * (workHistory + amphoe + LAO + workStatus + role + governmentAgencies)
   * so callers don't need to refetch.
   *
   * `hash` is expected to already be a hex digest produced by
   * `hashCitizenId` — this method does NOT re-hash. Empty / non-string
   * input returns `null` to avoid `where: { citizenIdHash: '' }` matching
   * any legacy row.
   */
  async findByCitizenIdHash(hash: string): Promise<User | null> {
    if (typeof hash !== 'string' || hash.length === 0) {
      return null;
    }
    try {
      const user = await this.userRepository.findOne({
        where: { citizenIdHash: hash },
        relations: [
          'workHistory',
          'workHistory.amphoe',
          'workHistory.localAdministrativeOrganization',
          'workHistory.workStatus',
          'workHistory.role',
          'workHistory.governmentAgencies',
        ],
      });
      if (!user) return null;
      return await this.decryptUserPii(user);
    } catch (error) {
      handleException(this.logger, error);
      return null;
    }
  }

  /**
   * W89 — Lookup a user by deterministic email hash. Returns the entity
   * with PII decrypted, or `null` if not found.
   *
   * Empty / non-string input returns `null` immediately to prevent the
   * "match anyone whose email_hash equals hash('')" failure mode.
   */
  async findByEmailHash(email: string): Promise<User | null> {
    if (typeof email !== 'string' || email.trim().length === 0) {
      return null;
    }
    try {
      const hash = hashEmail(email);
      const user = await this.userRepository.findOne({
        where: { emailHash: hash },
      });
      if (!user) return null;
      return await this.decryptUserPii(user);
    } catch (error) {
      handleException(this.logger, error);
      return null;
    }
  }

  /**
   * W89 — Lookup a user by deterministic phone hash. Same contract as
   * `findByEmailHash`.
   */
  async findByPhoneHash(phone: string): Promise<User | null> {
    if (typeof phone !== 'string' || phone.replace(/\D/g, '').length === 0) {
      return null;
    }
    try {
      const hash = hashPhone(phone);
      const user = await this.userRepository.findOne({
        where: { phoneHash: hash },
      });
      if (!user) return null;
      return await this.decryptUserPii(user);
    } catch (error) {
      handleException(this.logger, error);
      return null;
    }
  }

  /**
   * Wave 21 — Self-scoped preferences update. Mutates ONLY the three
   * notification preference fields (allowEmailNotification,
   * allowLineNotification, lineId). Other User columns are never touched.
   *
   * `userId` MUST come from the authenticated JWT context — NEVER from the
   * request body. This is enforced at the controller boundary.
   *
   * Returns a slim projection (not the full User entity) to avoid leaking
   * other columns (citizenId, hashes, relations). Architecture §4.3.
   */
  async updateMyPreferences(
    userId: string,
    dto: UpdateMyPreferencesDto,
  ): Promise<{
    id: string;
    allowEmailNotification: boolean | null;
    allowLineNotification: boolean | null;
    lineId: string | null;
  }> {
    try {
      // Pick-list enforcement — defense in depth even if the validation pipe
      // fails to reject extra fields. Only these three may reach the repo.
      const patch: Partial<User> = {};
      if (dto.allowEmailNotification !== undefined) {
        patch.allowEmailNotification = dto.allowEmailNotification;
      }
      if (dto.allowLineNotification !== undefined) {
        patch.allowLineNotification = dto.allowLineNotification;
      }
      if (dto.lineId !== undefined) {
        patch.lineId = dto.lineId;
      }

      if (Object.keys(patch).length === 0) {
        // No-op; still return the current slim projection for UI refresh.
        const current = await this.userRepository.findOne({
          where: { id: userId },
          select: ['id', 'allowEmailNotification', 'allowLineNotification', 'lineId'],
        });
        if (!current) {
          throw new NotFoundException(`User with ID ${userId} not found`);
        }
        return {
          id: current.id,
          allowEmailNotification: current.allowEmailNotification ?? null,
          allowLineNotification: current.allowLineNotification ?? null,
          lineId: current.lineId ?? null,
        };
      }

      const updateResult = await this.userRepository.update({ id: userId }, patch);
      if (!updateResult.affected) {
        throw new NotFoundException(`User with ID ${userId} not found`);
      }

      const updated = await this.userRepository.findOne({
        where: { id: userId },
        select: ['id', 'allowEmailNotification', 'allowLineNotification', 'lineId'],
      });
      if (!updated) {
        throw new NotFoundException(`User with ID ${userId} not found after update`);
      }
      return {
        id: updated.id,
        allowEmailNotification: updated.allowEmailNotification ?? null,
        allowLineNotification: updated.allowLineNotification ?? null,
        lineId: updated.lineId ?? null,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Soft deletes a user by ID.
   */
  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.userRepository.softDelete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`User with ID ${id} not found`);
      }
      return { message: `User with ID ${id} has been soft-deleted.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Permanently deletes a user by ID.
   *
   * BE-IMPL-01 P1-3 — PDPA hygiene. Profile-image bytes are personal
   * data; hard-deleting the row without removing the file leaves the
   * image accessible via UUID URL. Read the URL BEFORE the row
   * disappears, then delete the file alongside the row. Storage
   * failure is logged + swallowed; the DB delete is the canonical PDPA
   * action and must still succeed. Soft-delete intentionally leaves
   * the file in place because `restore()` would otherwise break.
   */
  async remove(id: string): Promise<{ message: string }> {
    try {
      // Capture the orphan URL before the row is deleted.
      const existing = await this.userRepository.findOne({
        where: { id },
        select: ['id', 'profileImageUrl'],
      });
      const orphanUrl = existing?.profileImageUrl ?? null;

      const result = await this.userRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`User with ID ${id} not found`);
      }

      if (orphanUrl) {
        this.storageService
          .deleteFileIfExist(orphanUrl)
          .catch((err) =>
            this.logger.warn(
              `remove: orphan profile-image cleanup failed for ${orphanUrl}: ${err?.constructor?.name ?? 'UnknownError'}`,
            ),
          );
      }
      return { message: `User with ID ${id} has been permanently removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Restores a soft-deleted user.
   */
  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.userRepository.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `Soft-deleted user with ID ${id} not found`,
        );
      }
      return { message: `User with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * BE-IMPL-01 P0-3 — Magic-byte sniff. Defends against a `.exe → .jpg`
   * rename and against MIME drift (claimed `image/png` but bytes are
   * `image/jpeg`). Throws UnprocessableEntityException with Thai message
   * on mismatch (matches BE-01 endpoint contract — FE-01 mapper checks
   * substrings `ไฟล์เสียหาย` and `ชนิดของไฟล์`).
   *
   * Returns the canonical MIME + canonical extension chosen from the
   * SNIFFED bytes — callers MUST use these instead of `originalname`
   * when computing the storage filename (closes BE-01 §B.6 P2-E
   * filename-from-claim risk).
   *
   * Implementation note: `file-type@^19+` is ESM-only and breaks the
   * project's CJS build (`No "exports" main defined`). Since this
   * feature only accepts three image formats, an inline magic-byte
   * check is simpler, dep-free, and doesn't fight the build pipeline:
   *
   *   JPEG: FF D8 FF
   *   PNG : 89 50 4E 47 0D 0A 1A 0A
   *   WebP: 52 49 46 46 .. .. .. .. 57 45 42 50  ("RIFF....WEBP")
   */
  private async sniffImage(
    file: Express.Multer.File,
  ): Promise<{
    mime: 'image/jpeg' | 'image/png' | 'image/webp';
    ext: '.jpg' | '.png' | '.webp';
  }> {
    const buf = file.buffer;
    let sniffedMime: 'image/jpeg' | 'image/png' | 'image/webp' | null = null;

    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      sniffedMime = 'image/jpeg';
    } else if (
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    ) {
      sniffedMime = 'image/png';
    } else if (
      buf.length >= 12 &&
      buf[0] === 0x52 && // R
      buf[1] === 0x49 && // I
      buf[2] === 0x46 && // F
      buf[3] === 0x46 && // F
      buf[8] === 0x57 && // W
      buf[9] === 0x45 && // E
      buf[10] === 0x42 && // B
      buf[11] === 0x50 // P
    ) {
      sniffedMime = 'image/webp';
    }

    if (!sniffedMime) {
      throw new UnprocessableEntityException(
        'ไฟล์เสียหายหรือไม่ใช่รูปภาพจริง',
      );
    }

    // MIME-drift guard — reject when the client-claimed MIME contradicts
    // the sniffed bytes. Some browsers send octet-stream for unknown
    // types; tolerate that case to avoid false positives.
    const claimed = file.mimetype?.toLowerCase() ?? '';
    if (
      claimed &&
      claimed !== sniffedMime &&
      claimed !== 'application/octet-stream'
    ) {
      throw new UnprocessableEntityException('ชนิดของไฟล์ไม่ตรงกับเนื้อหา');
    }

    const extByMime: Record<string, '.jpg' | '.png' | '.webp'> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
    };
    return {
      mime: sniffedMime,
      ext: extByMime[sniffedMime],
    };
  }

  /**
   * Uploads and updates a user's profile image.
   *
   * BE-IMPL-01 P0-3 + P1-1 — Order (crash-safe):
   *   1. magic-byte sniff
   *   2. write new file
   *   3. save DB pointing at new file
   *   4. delete old file (best-effort; failure logged but swallowed)
   *
   * If save-DB throws, the just-written new file is rolled back so we
   * do not orphan it. If delete-old throws, the new image is already
   * saved + DB consistent; the orphan is logged for a future cleanup
   * cron.
   */
  async uploadProfileImage(
    id: string,
    file: Express.Multer.File,
  ): Promise<User> {
    try {
      const user = await this.userRepository.findOne({ where: { id } });
      if (!user) {
        throw new NotFoundException(`User with ID ${id} not found`);
      }

      // 1. Magic-byte sniff (P0-3) — choose extension from sniffed bytes.
      const sniffed = await this.sniffImage(file);

      // 2. Write new file FIRST. If this fails the old image is untouched.
      const oldUrl = user.profileImageUrl;
      const imageUrl = await this.storageService.saveFile(
        file,
        'profiles',
        sniffed.ext,
      );

      // 3. Save DB pointing at the new file. If save fails, schedule the
      //    just-written file for cleanup so we don't orphan it on rollback.
      try {
        user.profileImageUrl = imageUrl;
        const updatedUser = await this.userRepository.save(user);

        // 4. Best-effort cleanup of old file. Failure is logged + swallowed
        //    — DB is already consistent and user sees the new image.
        if (oldUrl) {
          this.storageService
            .deleteFileIfExist(oldUrl)
            .catch((err) =>
              this.logger.warn(
                `uploadProfileImage: orphan-old-file cleanup failed for ${oldUrl}: ${err?.constructor?.name ?? 'UnknownError'}`,
              ),
            );
        }

        // W89 — return all PII columns decrypted, not just citizenId.
        return await this.decryptUserPii(updatedUser);
      } catch (saveErr) {
        // Roll back the just-written new file so we don't orphan it.
        await this.storageService
          .deleteFileIfExist(imageUrl)
          .catch(() => undefined);
        throw saveErr;
      }
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * BE-IMPL-01 P1-2 — Removes the user's profile image (idempotent).
   * If `profileImageUrl` is already null, no-ops and returns the user
   * unchanged. Otherwise: clears the column FIRST, persists DB, then
   * deletes the storage file (best-effort). DB consistency wins over
   * storage cleanup — orphaned files are logged for a future cron.
   */
  async removeProfileImage(id: string): Promise<User> {
    try {
      const user = await this.userRepository.findOne({ where: { id } });
      if (!user) {
        throw new NotFoundException(`User with ID ${id} not found`);
      }
      if (!user.profileImageUrl) {
        // Idempotent — already cleared, return decrypted user.
        return await this.decryptUserPii(user);
      }
      const oldUrl = user.profileImageUrl;
      // Cast through unknown because the entity declares
      // `profileImageUrl?: string` (no `| null`); SQL stores NULL.
      user.profileImageUrl = null as unknown as string;
      const updatedUser = await this.userRepository.save(user);
      this.storageService
        .deleteFileIfExist(oldUrl)
        .catch((err) =>
          this.logger.warn(
            `removeProfileImage: orphan cleanup failed for ${oldUrl}: ${err?.constructor?.name ?? 'UnknownError'}`,
          ),
        );
      return await this.decryptUserPii(updatedUser);
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
