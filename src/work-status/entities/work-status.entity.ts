import { Column, CreateDateColumn, DeleteDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity('work_status')
export class WorkStatus {
    @PrimaryGeneratedColumn('uuid')
    id : string; 

    @Column()
    name : string;

    @CreateDateColumn({name : 'create_at'})
    createdAt : Date;

    @DeleteDateColumn({nullable : true , name : 'delete_at'})
    deletedAt? : Date;
}
