import { TrackingStatus } from "src/tracking-status/entities/tracking-status.entity";
import { Column, CreateDateColumn, DeleteDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";

@Entity('status')
export class Status {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Column()
    name: string

    @Column()
    level: number


    @CreateDateColumn({ name: 'create_at' })
    createdAt: Date

    @DeleteDateColumn({ name: 'delete_at', type: 'timestamp', nullable: true })
    deleteAt: Date | null;


    @OneToMany(() => TrackingStatus , (trackingStatus) => trackingStatus.status , {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    trackingStatus : TrackingStatus[]



}
