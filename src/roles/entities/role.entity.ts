import { WorkHistory } from "src/work-history/entities/work-history.entity";
import { Column, CreateDateColumn, DeleteDateColumn, Entity, OneToMany, PrimaryGeneratedColumn } from "typeorm";

@Entity('roles')
export class Role {
    @PrimaryGeneratedColumn('uuid')
    id : string;

    @Column()
    name : string;


    @DeleteDateColumn({ name: 'deleted_at', nullable: true })
    deletedAt?: Date;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @OneToMany(() => WorkHistory , (workHistory) => workHistory.role, {
        onDelete : 'CASCADE',
        onUpdate : 'CASCADE'
    })
    workHistory : WorkHistory[]

}
