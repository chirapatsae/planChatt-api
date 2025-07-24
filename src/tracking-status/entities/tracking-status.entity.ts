import { Exclude } from "class-transformer";
import { Comment } from "src/comments/entities/comment.entity";
import { ProjectGroup } from "src/project-groups/entities/project-group.entity";
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
    @Exclude() 
    deletedAt?: Date;

    @ManyToOne(() => WorkHistory , (workHistory) => workHistory.deletorTrackingStatus , {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({name : 'deleted_by'})
    deletedBy : WorkHistory

    @Column({ default: () => 'CURRENT_TIMESTAMP', name: 'create_at' })
    createAt: Date;

    @ManyToOne(() => WorkHistory , (workHistory) => workHistory.creatorTrackingStatus , {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({name : 'created_by'})
    createdBy : WorkHistory


    @ManyToOne(() => ProjectGroup , (projectGroup) => projectGroup.trackingStatus , {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({name : 'project_group_id'})
    projectGroupId : ProjectGroup

    @ManyToOne(() => Status , (status) => status.trackingStatus , {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({name : 'status_id' } )
    statusId : Status


    @Column( {name : 'is_latest' , default : true})
    isLatest : boolean

    @OneToMany(() => Comment , (comment) => comment.trackingStatusId , {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    comments : Comment[]
}
