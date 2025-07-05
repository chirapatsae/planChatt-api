import { ProjectGroup } from "src/project-groups/entities/project-group.entity";
import { TrackingStatus } from "src/tracking-status/entities/tracking-status.entity";
import { User } from "src/users/entities/user.entity";
import { WorkHistory } from "src/work-history/entities/work-history.entity";
import { Column, DeleteDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";

@Entity({ name: "project_types" })
export class ProjectType {
    @PrimaryGeneratedColumn('uuid')
    id : string;

    @Column({ unique: true })
    name : string;

    @Column({ name: 'create_at', default: () => 'CURRENT_TIMESTAMP' })
    createAt : Date;

    @DeleteDateColumn({ name: 'deleted_at', nullable: true })
    deletedAt?: Date;
    

    @OneToMany(() => ProjectGroup , (projectGroup) => projectGroup.projectType , {
        onUpdate : 'CASCADE',
        onDelete : 'CASCADE'
    })
    projectGroup : ProjectGroup[]

    @OneToMany(() => TrackingStatus , (trackingStatus) => trackingStatus.projectType , {
        onUpdate : 'CASCADE',
        onDelete : 'CASCADE'
    })
    trackingStatus : TrackingStatus[]

}
