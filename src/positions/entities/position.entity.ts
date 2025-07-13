import { WorkHistory } from "src/work-history/entities/work-history.entity";
import { Column, CreateDateColumn, DeleteDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";

@Entity('positions')
export class Position {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @DeleteDateColumn({ name: 'deleted_at', nullable: true })
    deletedAt?: Date;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @ManyToOne(() => WorkHistory, (workHistory) => workHistory.position, {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
    })
    @JoinColumn({name : 'work_history'})
    workHistory: WorkHistory

    
} 