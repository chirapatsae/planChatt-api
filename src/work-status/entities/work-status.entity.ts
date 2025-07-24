import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('work_status')
export class WorkStatus {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @CreateDateColumn({ name: 'create_at' })
  createdAt: Date;

  @DeleteDateColumn({ nullable: true, name: 'delete_at' })
  deletedAt?: Date;

  @OneToMany(() => WorkHistory, (workHistory) => workHistory.workStatus, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  workHistory: WorkHistory[];
}
