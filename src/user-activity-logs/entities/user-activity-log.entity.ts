import { User } from "src/users/entities/user.entity";
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

@Entity( 'user_activity_logs')
export class UserActivityLog {

    @PrimaryGeneratedColumn('uuid')
    id : string;

    @Column({name : 'activity_type'})
    activityType    : string;

    @Column({name : 'activity_detail'})
    activvityDetail : string;

    @Column({name : 'ip_address'})
    ipAddress : string;

    @Column()
    platform : string;

    @Column({name : 'user_agent'})
    userAgent : string;

    @Column({name : 'created_at'})
    createdAt : Date;

    @ManyToOne(() => User, (user) => user.userActivityLogs)
    createdBy : User
}
