import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Role } from './entities/role.entity';
import { Repository } from 'typeorm';
import { handleException } from 'src/util/handleException';

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);
  constructor(
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
  ) {}

  async create(createRoleDto: CreateRoleDto) {
    try {
      const { name } = createRoleDto;
      const role = this.roleRepository.create({ name });
      return await this.roleRepository.save(role);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll() {
    try {
      return await this.roleRepository.find({
        where: { deletedAt: undefined },
        relations: [],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string) {
    try {
      const role = await this.roleRepository.findOne({
        where: { id },
        relations: [],
      });

      if (!role) {
        throw new NotFoundException(`Role with ID ${id} not found`);
      }
      return role;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(id: string, updateRoleDto: UpdateRoleDto) {
    try {
      const roleToUpdate = await this.roleRepository.preload({
        id,
        ...updateRoleDto,
      });

      if (!roleToUpdate) {
        throw new NotFoundException(`Role with ID ${id} not found`);
      }

      return await this.roleRepository.save(roleToUpdate);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.roleRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Role with ID ${id} not found`);
      }
      return { message: `Role with ID ${id} has been permanently removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.roleRepository.softDelete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Role with ID ${id} not found`);
      }
      return { message: `Role with ID ${id} has been soft-removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.roleRepository.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `Role with ID ${id} not found or was not deleted.`,
        );
      }
      return { message: `Role with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
