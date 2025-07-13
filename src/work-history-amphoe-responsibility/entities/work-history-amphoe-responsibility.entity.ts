import { Entity, PrimaryGeneratedColumn, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { WorkHistory } from '../../work-history/entities/work-history.entity';
import { Amphoe } from '../../amphoes/entities/amphoe.entity';

@Entity('work_history_amphoe_responsibilities')
export class WorkHistoryAmphoeResponsibility {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => WorkHistory, workHistory => workHistory.workHistoryResponsibleAdmins, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'work_history_id' })
  workHistory: WorkHistory;

  @ManyToOne(() => Amphoe, amphoe => amphoe.workHistoryResponsibleAdmins, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'amphoe_id' })
  amphoe: Amphoe;

  @ManyToOne(() => WorkHistory, { nullable: true })
  @JoinColumn({ name: 'assigned_by_work_history_id' })
  assignedByWorkHistory?: WorkHistory;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
