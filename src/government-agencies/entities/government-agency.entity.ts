import { Column, CreateDateColumn, DeleteDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity('government_agencies')
export class GovernmentAgency {
    @PrimaryGeneratedColumn('uuid')
    id : string;

    @Column()
    name : string;

    @DeleteDateColumn({ name: 'deleted_at', nullable: true })
    deletedAt?: Date;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
} 