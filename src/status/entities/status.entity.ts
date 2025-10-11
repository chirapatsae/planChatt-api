import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('status')
export class Status {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true  , default: ''})
  th_name: string;

  @CreateDateColumn({ name: 'create_at' })
  createdAt: Date;
  @ManyToOne(() => WorkHistory, (workHistory) => workHistory.creatorStatus, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'created_by' })
  createdBy: WorkHistory;

  @DeleteDateColumn({ name: 'delete_at', type: 'timestamp', nullable: true })
  deleteAt: Date | null;
  @ManyToOne(() => WorkHistory, (workHistory) => workHistory.deletorStatus, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'deleted_by' })
  deletedBy: WorkHistory;

  @OneToMany(
    () => TrackingStatus,
    (trackingStatus) => trackingStatus.statusId,
    {
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
  )
  trackingStatus: TrackingStatus[];
}
