import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * NationalStrategy — Strategic Graph master vocabulary entity.
 *
 * Source of truth:
 *   - DB-01 migration `1779120000000-StrategicGraphMasterTables.ts`
 *   - `docs/tasks/STRATEGIC_GRAPH_UMBRELLA.md`
 *
 * This is a configuration/master row. Per CLAUDE.md §17.3 it has NO
 * FK into any project/plan/tracking table. Junction tables in DB-02 /
 * DB-03 will reference this row via `ON DELETE RESTRICT`.
 */
@Entity('national_strategies')
export class NationalStrategy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  code: string | null;

  @Column({ name: 'name_th', type: 'varchar', length: 500 })
  nameTh: string;

  @Column({ name: 'name_en', type: 'varchar', length: 255, nullable: true })
  nameEn: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt: Date | null;
}
