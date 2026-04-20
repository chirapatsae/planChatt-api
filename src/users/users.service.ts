import {
  Injectable,
  Logger,
  NotFoundException,
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
        existingUser.citizenId = await decryption(existingUser.citizenId);
        return existingUser;
      }

      const encryptedCid = await encryption(createUserDto.citizenId);

      const user = this.userRepository.create({
        ...createUserDto,
        citizenId: encryptedCid,
        citizenIdHash: hashedCid,
      });

      const savedUser = await this.userRepository.save(user);

      // Assign default AI quota
      await this.aiUsageQuotasService.createDefaultQuota(savedUser.id);

      savedUser.citizenId = await decryption(savedUser.citizenId); // Decrypt for the response
      return savedUser;
    } catch (error) {
      // Log the error details for debugging
      this.logger.error(`Failed to create user: ${JSON.stringify(createUserDto)}`, error);
      handleException(this.logger, error);
    }
  }

  /**
   * Retrieves all users. Does not decrypt sensitive data for performance.
   */
  async findAll(): Promise<User[]> {
    try {
      return await this.userRepository.find({
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

      user.citizenId = await decryption(user.citizenId);
      return user;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Updates a user's details using the 'preload' pattern.
   */
  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    try {
      const { citizenId, ...otherDetails } = updateUserDto;
      const updatePayload: Partial<UpdateUserDto> = { ...otherDetails };

      // if (citizenId) {
      //   updatePayload['citizenId'] = await encryption(citizenId);
      //   updatePayload['citizenIdHash'] = hashCitizenId(citizenId);
      // }

      const userToUpdate = await this.userRepository.preload({
        id,
        ...updatePayload,
      });

      if (!userToUpdate) {
        throw new NotFoundException(`User with ID ${id} not found to update`);
      }

      const savedUser = await this.userRepository.save(userToUpdate);
      savedUser.citizenId = await decryption(savedUser.citizenId); // Decrypt for the response
      return savedUser;
    } catch (error) {
      handleException(this.logger, error);
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
   */
  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.userRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`User with ID ${id} not found`);
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
   * Uploads and updates a user's profile image.
   */
  async uploadProfileImage(id: string, file: Express.Multer.File): Promise<User> {
    try {
      const user = await this.userRepository.findOne({ where: { id } });
      if (!user) {
        throw new NotFoundException(`User with ID ${id} not found`);
      }

      // 1. Delete old image if it exists to save space
      if (user.profileImageUrl) {
        await this.storageService.deleteFileIfExist(user.profileImageUrl);
      }

      // 2. Save new image using StorageService
      const imageUrl = await this.storageService.saveFile(file, 'profiles');

      // 3. Update database
      user.profileImageUrl = imageUrl;
      const updatedUser = await this.userRepository.save(user);

      // Decrypt for response
      updatedUser.citizenId = await decryption(updatedUser.citizenId);

      return updatedUser;
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
