import { Budget } from 'src/budget/entities/budget.entity';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { ProjectType } from 'src/project-types/entities/project-type.entity';
import { User } from 'src/users/entities/user.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
    Column,
    CreateDateColumn,
    Entity,
    ManyToOne,
    PrimaryGeneratedColumn,
    JoinColumn,
    DeleteDateColumn,
    OneToMany,
} from 'typeorm';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Comment } from 'src/comments/entities/comment.entity';

@Entity('project_groups')
export class ProjectGroup {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    title: string;

    @Column('text')
    objective: string;

    @Column('text')
    goal: string;

    @Column('decimal', { precision: 10, scale: 7 })
    startLat: number;

    @Column('decimal', { precision: 10, scale: 7 })
    startLng: number;

    @Column('decimal', { precision: 10, scale: 7, nullable: true })
    endLat: number | null;
    
    @Column('decimal', { precision: 10, scale: 7, nullable: true })
    endLng: number | null;

    @Column('text')
    indicator: string;

    @Column('text')
    expected: string;

    @Column()
    projectYear: number;

    @DeleteDateColumn({ name: 'deleted_at', nullable: true })
    deletedAt?: Date;

    // แผนงบประมาณกี่ปี
    @ManyToOne(() => BudgetPlan, (budgetPlan) => budgetPlan.projectGroup, {
        onDelete : 'CASCADE',
        onUpdate : 'CASCADE',
    })
    @JoinColumn({ name: 'budget_plan_id' })
    budgetPlanId: BudgetPlan

    ประเภทโครงการ
    @ManyToOne(() => ProjectType, (projectType) => projectType.projectGroup)
    @JoinColumn({ name: 'project_type_id' })
    projectType: ProjectType;

    // 👤 ผู้เพิ่มโครงการ
    @ManyToOne(() => WorkHistory, (workHistory) => workHistory.projectGroup)
    @JoinColumn({ name: 'create_by' })
    workHistory?: WorkHistory;

    @Column({ nullable: true })
    responsibleOrgId?: number;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @OneToMany(() => Budget, (budget) => budget.projectGroup, {
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
    })
    budgets: Budget[]

    @OneToMany(() => TrackingStatus, (budget) => budget.projectGroup, {
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
    })
    trackingStatus: TrackingStatus[]

    @ManyToOne(() => Strategy, (strategy) => strategy.projectGroup, {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({ name: 'strategy_id' })
    strategy: Strategy;

    @ManyToOne(() => Tactic, (tactic) => tactic.projectGroup, {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({ name: 'tactic_id' })
    tactic: Tactic;

    @ManyToOne(() => Plan, (plan) => plan.projectGroup, {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({ name: 'plan_id' })
    plan: Plan;
}


