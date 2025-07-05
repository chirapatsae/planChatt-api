import { BudgetPlan } from './../../budget_plan/entities/budget_plan.entity';
import { Exclude } from 'class-transformer';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  Column,
  DeleteDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'citizen_id', unique: true })
  citizenId: string;

  @Column({ name: 'citizen_id_hash', unique: true })
  @Exclude() // 👈 ซ่อน
  citizenIdHash: string;

  @Column()
  prefix : string

  @Column()
  firstname : string

  @Column()
  lastname : string

  @Column({   nullable : true })
  email?: string;

  @Column({  nullable : true})
  phone?: string;

  @Column({name : 'is_first_login' , default : false})
  isFirstLogin : boolean

  @DeleteDateColumn({ nullable: true })
  @Exclude() // 👈 ซ่อน
  deletedAt?: Date;

  @Column({ default: () => 'CURRENT_TIMESTAMP', name: 'create_at' })
  createAt: Date;

  @OneToMany(() => WorkHistory, (workHistory) => workHistory.user, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  workHistory: WorkHistory[];

  @OneToMany(() => BudgetPlan, (budgetPlan) => budgetPlan.user, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  budgetPlan: BudgetPlan[];
}
