import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { CreateStrategyDto } from './dto/create-strategy.dto';
import { UpdateStrategyDto } from './dto/update-strategy.dto';
import { Strategy } from './entities/strategy.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

@Injectable()
export class StrategyService {

  private readonly logger = new Logger(StrategyService.name);

  constructor(
    @InjectRepository(Strategy)
    private readonly strategyRepository: Repository<Strategy>
  ) { }

  create(createStrategyDto: CreateStrategyDto) {
    return 'This action adds a new strategy';
  }

  async findAll(): Promise<Strategy[]> {
    this.logger.log('Fetching all strategies');
    try {
      return await this.strategyRepository.find();
    } catch (error) {
      this.logger.error('Error fetching all strategies', error.stack);
      throw new InternalServerErrorException('Failed to fetch strategies');
    }
  }

  async findOne(id: string): Promise<Strategy> {
    this.logger.log(`Fetching strategy with ID: ${id}`);
    try {
      const strategy = await this.strategyRepository
        .createQueryBuilder('strategy')
        .leftJoinAndSelect('strategy.tactic', 'tactic')
        .addSelect([
          'tactic.id',
          'tactic.name', // ✅ เพิ่มเฉพาะ column ที่ต้องการ
        ])
        .where('strategy.id = :id', { id })
        .getOne();
  
      if (!strategy) {
        throw new NotFoundException(`Strategy with ID ${id} not found`);
      }
  
      return strategy;
    } catch (error) {
      this.logger.error(`Error fetching strategy ${id}`, error.stack);
      throw error instanceof NotFoundException
        ? error
        : new InternalServerErrorException('Failed to fetch strategy');
    }
  }
  

  update(id: string, updateStrategyDto: UpdateStrategyDto) {
    return `This action updates a #${id} strategy`;
  }

  remove(id: string) {
    return `This action removes a #${id} strategy`;
  }
}
