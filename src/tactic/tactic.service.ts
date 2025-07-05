import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tactic } from './entities/tactic.entity';

@Injectable()
export class TacticService {
  private readonly logger = new Logger(TacticService.name);

  constructor(
    @InjectRepository(Tactic)
    private readonly tacticRepo: Repository<Tactic>,
  ) {}

  async findAll(): Promise<Tactic[]> {
    this.logger.log('Fetching all tactics');
    try {
      return await this.tacticRepo.find();
    } catch (error) {
      this.logger.error('Error fetching tactics', error.stack);
      throw new InternalServerErrorException('Failed to fetch tactics');
    }
  }

  async findOne(id: string): Promise<Tactic> {
    this.logger.log(`Fetching tactic with ID: ${id}`);
    try {
      const tactic = await this.tacticRepo.findOne({ where: { id } });
      if (!tactic) throw new NotFoundException(`Tactic ID ${id} not found`);
      return tactic;
    } catch (error) {
      this.logger.error(`Error fetching tactic ${id}`, error.stack);
      throw error;
    }
  }
}
