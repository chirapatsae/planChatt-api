import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, Not, DataSource, FindOptionsWhere } from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { decryption, encryption, hashCitizenId } from 'src/util/encryption.util';
import { plainToInstance } from 'class-transformer';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
    private readonly dataSource: DataSource,
  ) { }

  /**
     * Creates a new user after validating for uniqueness.
     * @param createUserDto - Data for the new user.
     * @returns The newly created user entity.
     */
  async create(createUserDto: CreateUserDto): Promise<User> {
    try {
      const { citizenId, email, phone } = createUserDto;
      const hashedCid = hashCitizenId(citizenId);

      await this._validateUniqueFields({ email, phone, citizenIdHash: hashedCid });

      const encryptedCid = await encryption(citizenId);

      const user = this.userRepository.create({
        ...createUserDto,
        citizenId: encryptedCid,
        citizenIdHash: hashedCid,
      });

      return await this.userRepository.save(user);
    } catch (error) {
      this.logger.error('Create user failed', error.stack);

      // --- Logic from handleDBError is now inlined here ---
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      // Handle unique constraint violation (PostgreSQL: 23505, MySQL: 1062)
      if (error.code === '23505' || error.errno === 1062) {
        const message: string = error.detail || error.message;
        if (message.includes('email')) {
          throw new BadRequestException('Email already exists.');
        }
        if (message.includes('phone')) {
          throw new BadRequestException('Phone number already exists.');
        }
        if (message.includes('citizen_id_hash')) {
          throw new BadRequestException('Citizen ID already exists.');
        }
      }

      throw new InternalServerErrorException('An unexpected database error occurred.');
      // --- End of inlined logic ---
    }
  }

  /**
   * Retrieves all non-deleted users and decrypts their citizen IDs.
   * @returns A list of all user entities.
   */
  async findAll(): Promise<User[]> {
    try {
      const users = await this.userRepository.find({
        where: { deletedAt: IsNull() },
        relations: ['workHistory'],
      });

      // Decrypt citizen ID for each user.
      // Note: This can be a performance bottleneck on large datasets.
      // Consider pagination or returning a DTO without the decrypted ID for list views.
      const decryptedUsers = await Promise.all(
        users.map(async (user) => ({
          ...user,
          citizenId: await decryption(user.citizenId),
        })),
      );

      return plainToInstance(User, decryptedUsers);
    } catch (error) {
      this.logger.error('Find all users failed', error.stack);
      throw new InternalServerErrorException('Failed to retrieve users');
    }
  }

  /**
   * Finds a single user by ID, decrypts their citizen ID, and attaches the latest work history.
   * @param id - The UUID of the user.
   * @returns The user entity with decrypted data.
   */
  async findOne(id: string): Promise<User> {
    try {
      const user = await this.getUserOrThrow(id);

      const latestHistory = await this.workHistoryRepository.findOne({
        where: { user: { id } },
        order: { createAt: 'DESC' },
      });

      const decryptedCitizenId = await decryption(user.citizenId);

      return plainToInstance(User, {
        ...user,
        citizenId: decryptedCitizenId,
        workHistory: latestHistory, // This might already be on the user if relations are loaded
      });
    } catch (error) {
      this.logger.error(`Find user ${id} failed`, error.stack);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(`Failed to retrieve user with ID ${id}`);
    }
  }

  /**
   * Updates a user's details after validating new unique fields.
   * @param id - The UUID of the user to update.
   * @param updateUserDto - The data to update.
   * @returns The updated user entity.
   */
  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    try {
      await this.getUserOrThrow(id); // Ensure user exists before proceeding

      const { citizenId, email, phone } = updateUserDto;
      let hashedCid: string | undefined;
      let encryptedCid: string | undefined;

      // Prepare data for validation and update
      if (citizenId) {
        hashedCid = hashCitizenId(citizenId);
        encryptedCid = await encryption(citizenId);
        await this._validateUniqueFields({ citizenIdHash: hashedCid }, id);
      }
      if (email) await this._validateUniqueFields({ email }, id);
      if (phone) await this._validateUniqueFields({ phone }, id);

      const updatePayload = {
        ...updateUserDto,
        ...(encryptedCid && { citizenId: encryptedCid }),
        ...(hashedCid && { citizenIdHash: hashedCid }),
      };

      // TypeORM's save method with an ID will perform an update.
      await this.userRepository.save({ id, ...updatePayload });

      return this.findOne(id); // Return the full, updated user entity
    } catch (error) {
      this.logger.error(`Update user ${id} failed`, error.stack);
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException(`Failed to update user with ID ${id}`);
    }
  }



  /**
   * Soft deletes a user by setting the `deletedAt` timestamp.
   * @param id - The UUID of the user to soft delete.
   */
  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const user = await this.getUserOrThrow(id);
      await this.userRepository.softRemove(user);
      return { message: `User with ID ${id} has been soft deleted` };
    } catch (error) {
      this.logger.error(`Soft delete user ${id} failed`, error.stack);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(`Failed to soft delete user with ID ${id}`);
    }
  }

  /**
   * Permanently deletes a user from the database.
   * @param id - The UUID of the user to permanently delete.
   */
  async remove(id: string): Promise<{ message: string }> {
    try {
      const user = await this.getUserOrThrow(id);
      await this.userRepository.remove(user);
      return { message: `User with ID ${id} has been permanently deleted` };
    } catch (error) {
      this.logger.error(`Permanent delete user ${id} failed`, error.stack);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(`Failed to permanently delete user with ID ${id}`);
    }
  }

  /**
   * Restores a soft-deleted user.
   * @param id - The UUID of the user to restore.
   */
  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.userRepository.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Soft-deleted user with ID ${id} not found`);
      }
      return { message: `User with ID ${id} has been restored` };
    } catch (error) {
      this.logger.error(`Restore user ${id} failed`, error.stack);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(`Failed to restore user with ID ${id}`);
    }
  }

  // =================================================================================
  // PRIVATE HELPER METHODS
  // =================================================================================

  /**
   * A reusable helper to fetch a user by ID or throw a NotFoundException.
   * @param id - The UUID of the user.
   * @returns The user entity.
   * @private
   */
  private async getUserOrThrow(id: string): Promise<User> {
    const user = await this.userRepository.findOneBy({ id });
    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
    return user;
  }

  /**
   * Checks for the existence of a user based on unique fields (email, phone, citizenIdHash).
   * Throws a BadRequestException if a duplicate is found.
   * @param fields - The fields to check for uniqueness.
   * @param excludeId - An optional user ID to exclude from the check (used during updates).
   * @private
   */
  private async _validateUniqueFields(
    fields: { email?: string; phone?: string; citizenIdHash?: string },
    excludeId?: string,
  ): Promise<void> {
    const whereClauses: FindOptionsWhere<User>[] = [];

    if (fields.email) whereClauses.push({ email: fields.email });
    if (fields.phone) whereClauses.push({ phone: fields.phone });
    if (fields.citizenIdHash) whereClauses.push({ citizenIdHash: fields.citizenIdHash });

    if (whereClauses.length === 0) return;

    // Add exclusion for the current user's ID if provided
    const finalWhere = excludeId ? whereClauses.map(clause => ({ ...clause, id: Not(excludeId) })) : whereClauses;

    const existingUser = await this.userRepository.findOne({ where: finalWhere });

    if (existingUser) {
      if (fields.email && existingUser.email === fields.email) {
        throw new BadRequestException('Email already exists');
      }
      if (fields.phone && existingUser.phone === fields.phone) {
        throw new BadRequestException('Phone number already exists');
      }
      if (fields.citizenIdHash && existingUser.citizenIdHash === fields.citizenIdHash) {
        throw new BadRequestException('Citizen ID already exists');
      }
    }
  }

}