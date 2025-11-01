import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { WorkHistory } from '../../work-history/entities/work-history.entity';
import { GovernmentAgency } from '../../government-agencies/entities/government-agency.entity';

@Entity('work_history_government_agency_responsibilities')
export class WorkHistoryGovernmentAgencyResponsibility {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(
    () => WorkHistory,
    (workHistory) => workHistory.workHistoryResponsibleGovernmentAgency,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
  )
  @JoinColumn({ name: 'work_history_id' })
  workHistory: WorkHistory;

  @ManyToOne(() => GovernmentAgency, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'government_agency_id' })
  governmentAgency: GovernmentAgency;

  @ManyToOne(() => WorkHistory, { nullable: true })
  @JoinColumn({ name: 'assigned_by_work_history_id' })
  assignedByWorkHistory?: WorkHistory;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
