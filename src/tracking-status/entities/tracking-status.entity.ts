import { Exclude } from "class-transformer";
import { Comment } from "src/comments/entities/comment.entity";
import { ProjectGroup } from "src/project-groups/entities/project-group.entity";
import { ProjectType } from "src/project-types/entities/project-type.entity";
import { Status } from "src/status/entities/status.entity";
import { WorkHistory } from "src/work-history/entities/work-history.entity";
import { Column, CreateDateColumn, DeleteDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";


@Entity('tracking_status')
export class TrackingStatus {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ nullable: true }) 
    comment?: string

    @DeleteDateColumn({ nullable: true })
    @Exclude() // 👈 ซ่อน
    deletedAt?: Date;


    @Column({ default: () => 'CURRENT_TIMESTAMP', name: 'create_at' })
    createAt: Date;

    @ManyToOne(() => ProjectGroup , (projectGroup) => projectGroup.trackingStatus , {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({name : 'project_group_id'})
    projectGroup : ProjectGroup

    @ManyToOne(() => Status , (status) => status.trackingStatus , {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({name : 'status_id' } )
    status : Status

    @ManyToOne(() => WorkHistory , (workHistory) => workHistory.trackingStatus , {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({name : 'create_by'})
    workHistory : WorkHistory

    @ManyToOne(() => ProjectType , (projectType) => projectType.trackingStatus , {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({name : 'project_type_id'})
    projectType : ProjectType

    @OneToMany(() => Comment , (comment) => comment.trackingStatus , {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    comments : Comment[]
}
