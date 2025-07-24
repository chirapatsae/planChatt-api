import { Entity, PrimaryGeneratedColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Plan } from './plan.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';

@Entity('plan_tactics')
export class PlanTactic {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Plan, (plan) => plan.planTactics, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan;

  @ManyToOne(() => Tactic, (tactic) => tactic.planTactics, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'tactic_id' })
  tactic: Tactic;
}
