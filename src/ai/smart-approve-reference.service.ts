import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { PlanTactic } from 'src/plan/entities/plan-tactic.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';

@Injectable()
export class SmartApproveReferenceService {
  constructor(
    @InjectRepository(Strategy)
    private readonly strategyRepo: Repository<Strategy>,
    @InjectRepository(Tactic)
    private readonly tacticRepo: Repository<Tactic>,
    @InjectRepository(Plan)
    private readonly planRepo: Repository<Plan>,
    @InjectRepository(PlanTactic)
    private readonly planTacticRepo: Repository<PlanTactic>,
    @InjectRepository(Amphoe)
    private readonly amphoeRepo: Repository<Amphoe>,
    @InjectRepository(LocalAdministrativeOrganization)
    private readonly localOrgRepo: Repository<LocalAdministrativeOrganization>,
  ) { }

  private normalizeName(name?: string): string | null {
    if (!name) return null;
    return name.replace(/\s+/g, ' ').trim();
  }

  async getAmphoeById(amphoeId?: number): Promise<Amphoe | undefined> {
    if (typeof amphoeId !== 'number') return undefined;
    const result = await this.amphoeRepo.findOne({
      where: { id: String(amphoeId) }, // Amphoe ID in entity is string
    });
    return result || undefined;
  }

  async getLocalOrganizationById(
    localOrganizationId?: number,
  ): Promise<LocalAdministrativeOrganization | undefined> {
    if (typeof localOrganizationId !== 'number') return undefined;
    const result = await this.localOrgRepo.findOne({
      where: { id: String(localOrganizationId) }, // ID in entity is string
      relations: ['amphoe'],
    });
    return result || undefined;
  }

  async findStrategyByName(name?: string): Promise<Strategy | undefined> {
    const normalized = this.normalizeName(name);
    if (!normalized) return undefined;

    // Scan for exact match or case-insensitive match
    // Note: ILike is case-insensitive for PostgreSQL
    const result = await this.strategyRepo.findOne({
      where: { name: ILike(normalized) },
    });
    return result || undefined;
  }

  async findTacticByName(name?: string): Promise<Tactic | undefined> {
    const normalized = this.normalizeName(name);
    if (!normalized) return undefined;
    const result = await this.tacticRepo.findOne({
      where: { name: ILike(normalized) },
      relations: ['strategy'],
    });
    return result || undefined;
  }

  async findPlanByName(name?: string): Promise<Plan | undefined> {
    const normalized = this.normalizeName(name);
    if (!normalized) return undefined;
    const result = await this.planRepo.findOne({
      where: { name: ILike(normalized) },
    });
    return result || undefined;
  }

  async getStrategyById(strategyId: string): Promise<Strategy | undefined> {
    const result = await this.strategyRepo.findOne({ where: { id: strategyId } });
    return result || undefined;
  }

  async getPlansForTactic(tacticId: string): Promise<Plan[]> {
    const planTactics = await this.planTacticRepo.find({
      where: { tactic: { id: tacticId } },
      relations: ['plan'],
    });
    return planTactics.map((pt) => pt.plan);
  }

  async getTacticsForStrategy(strategyId: string): Promise<Tactic[]> {
    return this.tacticRepo.find({
      where: { strategy: { id: strategyId } },
    });
  }

  async isPlanLinkedToTactic(planId: string, tacticId: string): Promise<boolean> {
    const count = await this.planTacticRepo.count({
      where: {
        plan: { id: planId },
        tactic: { id: tacticId },
      },
    });
    return count > 0;
  }
}

