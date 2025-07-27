import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity('project_types')
export class ProjectType {
    @PrimaryGeneratedColumn('uuid')
    id : string;

    @Column()
    name : string;
}
