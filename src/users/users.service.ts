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
import {
  decryption,
  encryption,
  hashCitizenId,
} from 'src/util/encryption.util';
import { handleException } from 'src/util/handleException';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

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
          },
          aiUsageQuota: true,
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
}
