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
  @Exclude()
  citizenIdHash: string;

  @Column()
  prefix: string

  @Column()
  firstname: string

  @Column()
  lastname: string

  @Column({ nullable: true })
  email?: string;

  @Column({ nullable: true })
  phone?: string;

  @Column({ name: 'is_first_login', default: true })
  isFirstLogin: boolean

  @DeleteDateColumn({ nullable: true, name: 'delete_at' })
  @Exclude()
  deletedAt?: Date;

  @Column({ default: () => 'CURRENT_TIMESTAMP', name: 'create_at' })
  createAt: Date;

  @OneToMany(() => WorkHistory, (workHistory) => workHistory.user, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  workHistory: WorkHistory[];
  
  @OneToMany(() => WorkHistory, (workHistory) => workHistory.createdBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  createdWorkHistory: WorkHistory[];

}
