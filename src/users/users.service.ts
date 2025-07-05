import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, Not, DataSource } from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto, OnboardDto } from './dto/create-user.dto';
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
    private readonly dataSource: DataSource // 👈 Inject ตรงนี้

  ) { }

  async create(dto: CreateUserDto): Promise<User> {
    try {
      const { citizenId, email, phone } = dto;

      const hashedCid = hashCitizenId(citizenId);
      const encryptedCid = await encryption(citizenId);

      const [byEmail, byPhone, byCitizen] = await Promise.all([
        email?.trim() ? this.userRepository.findOneBy({ email: email.trim() }) : null,
        phone?.trim() ? this.userRepository.findOneBy({ phone: phone.trim() }) : null,
        this.userRepository.findOneBy({ citizenIdHash: hashedCid }),
      ]);
      
      if (byEmail) throw new BadRequestException('Email already exists');
      if (byPhone) throw new BadRequestException('Phone number already exists');
      if (byCitizen) throw new BadRequestException('Citizen ID already exists');
      

      const user = this.userRepository.create({
        ...dto,
        citizenId: encryptedCid,
        citizenIdHash: hashedCid,
      });

      return await this.userRepository.save(user);
    } catch (error) {
      this.logger.error('Create user failed', error.stack);
      this.handleDBError(error);
    }
  }

  async findAll(): Promise<User[]> {
    try {
      const users = await this.userRepository.find({
        where: { deletedAt: IsNull() },
        relations: ['workHistory'],
      });

      const decrypted = await Promise.all(
        users.map(async (user) => ({
          ...user,
          citizenId: await decryption(user.citizenId),
        })),
      );

      return plainToInstance(User, decrypted);
    } catch (error) {
      this.logger.error('Find all users failed', error.stack);
      throw new InternalServerErrorException('Failed to retrieve users');
    }
  }

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
        workHistory: latestHistory,
      });
    } catch (error) {
      this.logger.error(`Find user ${id} failed`, error.stack);
      throw error instanceof NotFoundException
        ? error
        : new InternalServerErrorException(`Failed to retrieve user with ID ${id}`);
    }
  }

  async update(id: string, dto: UpdateUserDto): Promise<User> {
    try {
      const user = await this.getUserOrThrow(id);

      const { citizenId, email, phone, prefix, firstname, lastname } = dto;
      console.log(dto)
      if (citizenId && citizenId !== '') {
        const hashedCid = hashCitizenId(citizenId);
        const existing = await this.userRepository.findOne({
          where: { citizenIdHash: hashedCid, id: Not(id) },
        });
        if (existing) throw new BadRequestException('Citizen ID already exists');

        user.citizenIdHash = hashedCid;
        user.citizenId = await encryption(citizenId);
      }

      if (email && email !== user.email) {
        const existing = await this.userRepository.findOne({
          where: { email, id: Not(id) },
        });
        if (existing) throw new BadRequestException('Email already exists');
        user.email = email;
      }

      if (phone && phone !== user.phone) {
        const existing = await this.userRepository.findOne({
          where: { phone, id: Not(id) },
        });
        if (existing) throw new BadRequestException('Phone number already exists');
        user.phone = phone;
      }
      if (prefix) {
        user.prefix = prefix
      }
      if (firstname) {
        user.firstname = firstname
      }
      if (lastname) {
        user.lastname = lastname
      }

      Object.assign(user, dto);

      return await this.userRepository.save(user);
    } catch (error) {
      this.logger.error(`Update user ${id} failed`, error.stack);
      throw error instanceof BadRequestException || error instanceof NotFoundException
        ? error
        : new InternalServerErrorException(`Failed to update user with ID ${id}`);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const user = await this.getUserOrThrow(id);
      await this.userRepository.softRemove(user);
      return { message: `User with ID ${id} has been soft deleted` };
    } catch (error) {
      this.logger.error(`Soft delete user ${id} failed`, error.stack);
      throw error instanceof NotFoundException ? error : new InternalServerErrorException();
    }
  }

// onboard.service.ts
async onboardUserAndWorkHistory(dto: OnboardDto) {
  return await this.dataSource.transaction(async manager => {
    const userRepo = manager.getRepository(User);
    const workHistoryRepo = manager.getRepository(WorkHistory);
    console.log('dto', dto)
    // 1. อัปเดตผู้ใช้
    await userRepo.update(dto.userId, {
      email: dto.email,
      phone: dto.phone,
      isFirstLogin : true
    });

    // 2. ตรวจสอบ work history ปัจจุบันที่ approved
    const currentApproved = await workHistoryRepo.findOne({
      where: {
        user: { id: dto.userId },
        status: 'approved',
      },
      relations: ['amphoe', 'localAdministrativeOrganization' ],
    });

    // 3. ถ้า currentApproved มี และตรงกับของใหม่ → ข้ามได้เลย
    if (
      currentApproved &&
      currentApproved.amphoe?.id === dto.amphoeId &&
      currentApproved.localAdministrativeOrganization?.id === dto.localAdministrativeOrganizationId
    ) {
      return currentApproved;
    }
    
    // 4. ปิด workHistory เดิมทั้งหมด
    await workHistoryRepo.update(
      { user: { id: dto.userId } },
      { status: 'suspended' },
    );

    // 5. สร้างใหม่
    const newHistory = this.workHistoryRepository.create({
      status: 'approved',
      user : {id : dto.userId},
      amphoe: { id: dto.amphoeId },
      localAdministrativeOrganization: { id: dto.localAdministrativeOrganizationId },
      divisionId : dto.divisionId,
      divisionName : dto.divisionName
    });

    return await workHistoryRepo.save(newHistory);
  });
}



  async remove(id: string): Promise<{ message: string }> {
    try {
      const user = await this.getUserOrThrow(id);
      await this.userRepository.remove(user);
      return { message: `User with ID ${id} has been permanently deleted` };
    } catch (error) {
      this.logger.error(`Permanent delete user ${id} failed`, error.stack);
      throw error instanceof NotFoundException ? error : new InternalServerErrorException();
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.userRepository.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(`User with ID ${id} not found`);
      }
      return { message: `User with ID ${id} has been restored` };
    } catch (error) {
      this.logger.error(`Restore user ${id} failed`, error.stack);
      throw error instanceof NotFoundException ? error : new InternalServerErrorException();
    }
  }

  // ✅ Reusable helper
  private async getUserOrThrow(id: string): Promise<User> {
    const user = await this.userRepository.findOneBy({ id });
    if (!user) throw new NotFoundException(`User with ID ${id} not found`);
    return user;
  }

  // ✅ Central error mapping
  private handleDBError(error: any): never {
    if (error instanceof BadRequestException) throw error;

    if (error.code === '23505' || error.errno === 1062) {
      const msg = error.detail || error.message;
      if (msg.includes('email')) throw new BadRequestException('Email already exists');
      if (msg.includes('phone')) throw new BadRequestException('Phone number already exists');
      if (msg.includes('citizen_id') || msg.includes('citizen_id_hash')) {
        throw new BadRequestException('Citizen ID already exists');
      }
    }

    throw new InternalServerErrorException('Unexpected error while processing user');
  }
}
