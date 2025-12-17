import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

type Amphoe = { id: number; name: string };
type LocalOrganization = {
  id: number;
  name: string;
  type: string;
  amphoe_id: number;
};

type Strategy = { id: string; name: string };
type Tactic = { id: string; name: string; strategy_id: string };
type Plan = { id: string; name: string };
type PlanTactic = { plan_id: string; tactic_id: string };

interface SmartApproveReferenceData {
  amphoes: Amphoe[];
  local_organizations: LocalOrganization[];
  strategies: Strategy[];
  tactics: Tactic[];
  plans: Plan[];
  plan_tactics: PlanTactic[];
}

@Injectable()
export class SmartApproveReferenceService {
  private readonly logger = new Logger(SmartApproveReferenceService.name);
  private data: SmartApproveReferenceData | null = null;
  private strategiesByName = new Map<string, Strategy>();
  private tacticsByName = new Map<string, Tactic>();
  private plansByName = new Map<string, Plan>();
  private planTacticRelations = new Set<string>();

  private normalizeName(name?: string): string | null {
    if (!name) return null;
    return name.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private buildIndexes() {
    if (!this.data) return;
    this.strategiesByName.clear();
    this.tacticsByName.clear();
    this.plansByName.clear();
    this.planTacticRelations.clear();

    this.data.strategies.forEach((strategy) => {
      const normalized = this.normalizeName(strategy.name);
      if (normalized) {
        this.strategiesByName.set(normalized, strategy);
      }
    });

    this.data.tactics.forEach((tactic) => {
      const normalized = this.normalizeName(tactic.name);
      if (normalized) {
        this.tacticsByName.set(normalized, tactic);
      }
    });

    this.data.plans.forEach((plan) => {
      const normalized = this.normalizeName(plan.name);
      if (normalized) {
        this.plansByName.set(normalized, plan);
      }
    });

    this.data.plan_tactics.forEach((relation) => {
      this.planTacticRelations.add(`${relation.plan_id}::${relation.tactic_id}`);
    });
  }

  constructor() {
    this.loadData();
  }

  private loadData() {
    if (this.data) {
      return;
    }

    const filePath = path.resolve(
      process.cwd(),
      'Project Bank Data',
      'smartapprove_base_data.json.json',
    );

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SmartApproveReferenceData>;
      this.data = {
        amphoes: parsed.amphoes ?? [],
        local_organizations: parsed.local_organizations ?? [],
        strategies: parsed.strategies ?? [],
        tactics: parsed.tactics ?? [],
        plans: parsed.plans ?? [],
        plan_tactics: parsed.plan_tactics ?? [],
      };
      this.logger.log(
        `Loaded SmartApprove reference data. Amphoes: ${this.data.amphoes.length}, Local orgs: ${this.data.local_organizations.length}, Strategies: ${this.data.strategies.length}, Tactics: ${this.data.tactics.length}, Plans: ${this.data.plans.length}`,
      );
      this.buildIndexes();
    } catch (error) {
      this.logger.error(
        `Cannot load SmartApprove base data from ${filePath}: ${error?.message || error}`,
      );
      this.data = {
        amphoes: [],
        local_organizations: [],
        strategies: [],
        tactics: [],
        plans: [],
        plan_tactics: [],
      };
      this.buildIndexes();
    }
  }

  private ensureData(): SmartApproveReferenceData {
    if (!this.data) {
      this.loadData();
    }
    return this.data as SmartApproveReferenceData;
  }

  getAmphoeById(amphoeId?: number): Amphoe | undefined {
    if (typeof amphoeId !== 'number') return undefined;
    return this.ensureData().amphoes.find((amphoe) => amphoe.id === amphoeId);
  }

  getLocalOrganizationById(
    localOrganizationId?: number,
  ): LocalOrganization | undefined {
    if (typeof localOrganizationId !== 'number') return undefined;
    return this.ensureData().local_organizations.find(
      (org) => org.id === localOrganizationId,
    );
  }

  findStrategyByName(name?: string): Strategy | undefined {
    const normalized = this.normalizeName(name);
    if (!normalized) return undefined;
    this.ensureData();
    return this.strategiesByName.get(normalized);
  }

  findTacticByName(name?: string): Tactic | undefined {
    const normalized = this.normalizeName(name);
    if (!normalized) return undefined;
    this.ensureData();
    return this.tacticsByName.get(normalized);
  }

  findPlanByName(name?: string): Plan | undefined {
    const normalized = this.normalizeName(name);
    if (!normalized) return undefined;
    this.ensureData();
    return this.plansByName.get(normalized);
  }

  getStrategyById(strategyId: string): Strategy | undefined {
    this.ensureData();
    return this.data?.strategies.find((strategy) => strategy.id === strategyId);
  }

  getPlansForTactic(tacticId: string): Plan[] {
    this.ensureData();
    if (!this.data) return [];
    const planIds = this.data.plan_tactics
      .filter((relation) => relation.tactic_id === tacticId)
      .map((relation) => relation.plan_id);
    return this.data.plans.filter((plan) => planIds.includes(plan.id));
  }

  getTacticsForStrategy(strategyId: string): Tactic[] {
    this.ensureData();
    if (!this.data) return [];
    return this.data.tactics.filter(
      (tactic) => tactic.strategy_id === strategyId,
    );
  }

  isPlanLinkedToTactic(planId: string, tacticId: string): boolean {
    this.ensureData();
    return this.planTacticRelations.has(`${planId}::${tacticId}`);
  }
}

