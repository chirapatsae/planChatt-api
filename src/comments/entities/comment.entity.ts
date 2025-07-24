import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { Status } from 'src/status/entities/status.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'comment' })
export class Comment {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Column()
    detail: string;

    @Column()
    step: number

    @Column({ name: 'create_at' , default: () => 'CURRENT_TIMESTAMP' })
    createAt: Date;


    @ManyToOne(() => TrackingStatus, (trackingStatus) => trackingStatus.comments, {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({ name: 'tracking_status_id' })
    trackingStatusId: TrackingStatus

}
