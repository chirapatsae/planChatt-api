import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
  } from 'typeorm';
  import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
  import { WorkHistory } from 'src/work-history/entities/work-history.entity';
  
  // ประกาศ enum สำหรับ phaseType
  export enum PhaseType {
    LAO = 'LAO', // อปท.
    AGENCY = 'AGENCY', // ส่วนราชการ
  }
  
  @Entity('plan_phases')
  export class PlanPhase {
    @PrimaryGeneratedColumn('uuid')
    id: string;
  
    @ManyToOne(() => BudgetPlan, (budgetPlan) => budgetPlan.planPhases, {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    })
    @JoinColumn({ name: 'budget_plan_id' })
    budgetPlan: BudgetPlan;
  
    @Column({ type: 'timestamp' })
    openDate: Date;
  
    @Column({ type: 'timestamp' })
    closeDate: Date;
  
    @Column({
      type: 'enum',
      enum: PhaseType,
    })
    phaseType: PhaseType; // เปิดให้ใครกรอก (อปท. หรือ ส่วนราชการ)
  
    @Column({ default: false })
    isMerged: boolean; // รวมเล่มแล้วหรือยัง
  
    @CreateDateColumn({ type: 'timestamp' })
    createdAt: Date;
  
    @ManyToOne(() => WorkHistory, { onDelete: 'SET NULL' })
    @JoinColumn({ name: 'created_by' })
    createdBy: WorkHistory;
  
    // ✅ Virtual computed field ไม่เก็บใน DB
    get status(): 'Open' | 'Close' | 'Merged' {
      const now = new Date();
      if (this.isMerged) return 'Merged';
      if (now >= this.openDate && now <= this.closeDate) return 'Open';
      return 'Close';
    }
  }
  