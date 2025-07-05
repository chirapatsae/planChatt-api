import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plan } from './entities/plan.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { PlanTactic } from './entities/plan-tactic.entity';

@Injectable()
export class PlanService {
  private readonly logger = new Logger(PlanService.name);

  constructor(
    @InjectRepository(Plan)
    private readonly planRepo: Repository<Plan>,
    @InjectRepository(Tactic)
    private readonly tacticRepo: Repository<Tactic>,

    @InjectRepository(PlanTactic)
    private readonly planTacticRepo: Repository<PlanTactic>,
  ) { }


  async findAll(): Promise<Plan[]> {
    return this.planRepo.find({
      relations: ['planTactics', 'planTactics.tactic', 'planTactics.tactic.strategy'],
    });
  }

  async findOne(id: string): Promise<Plan> {
    const plan = await this.planRepo.findOne({
      where: { id },
      relations: ['planTactics', 'planTactics.tactic', 'planTactics.tactic.strategy'],
    });

    if (!plan) throw new NotFoundException(`Plan with ID ${id} not found`);
    return plan;
  }

  // plan.service.ts
  async findPlansByTacticId(tacticId: string): Promise<Plan[]> {
    const planTactics = await this.planTacticRepo.find({
      where: { tactic: { id: tacticId } },
      relations: ['plan'],
    });

    return planTactics.map(pt => pt.plan);
  }

}
