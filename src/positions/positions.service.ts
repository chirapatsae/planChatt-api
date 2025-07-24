import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreatePositionDto } from './dto/create-position.dto';
import { UpdatePositionDto } from './dto/update-position.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Position } from './entities/position.entity';
import { Repository } from 'typeorm';
import { handleException } from 'src/util/handleException';
import { User } from 'src/users/entities/user.entity';

@Injectable()
export class PositionsService {
  private readonly logger = new Logger(PositionsService.name);
  constructor(
    @InjectRepository(Position)
    private readonly positionRepository: Repository<Position>,

    @InjectRepository(User)
    private readonly userReposition: Repository<User>,
  ) {}

  async create(createPositionDto: CreatePositionDto) {
    try {
      const { name, userId } = createPositionDto;

      const user = await this.userReposition.findOne({ where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');

      await this.positionRepository.update(
        { user: { id: userId }, isLatest: true },
        { isLatest: false },
      );

      const position = this.positionRepository.create({
        name,
        isLatest: true,
        user,
      });

      return await this.positionRepository.save(position);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll() {
    try {
      return await this.positionRepository.find({
        where: { deletedAt: undefined },
        relations: ['user'],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string) {
    try {
      const position = await this.positionRepository.findOne({
        where: { id },
        relations: ['user'],
      });

      if (!position) {
        throw new NotFoundException(`Position with ID ${id} not found`);
      }
      return position;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(id: string, updatePositionDto: UpdatePositionDto) {
    try {
      const positionToUpdate = await this.positionRepository.preload({
        id,
        ...updatePositionDto,
      });

      if (!positionToUpdate) {
        throw new NotFoundException(`Position with ID ${id} not found`);
      }

      return await this.positionRepository.save(positionToUpdate);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.positionRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Position with ID ${id} not found`);
      }
      return {
        message: `Position with ID ${id} has been permanently removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.positionRepository.softDelete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Position with ID ${id} not found`);
      }
      return { message: `Position with ID ${id} has been soft-removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.positionRepository.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `Position with ID ${id} not found or was not deleted.`,
        );
      }
      return { message: `Position with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
