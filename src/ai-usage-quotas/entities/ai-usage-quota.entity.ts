import { AiUsageLog } from "src/ai-usage-logs/entities/ai-usage-log.entity";
import { User } from "src/users/entities/user.entity";
import { Column, CreateDateColumn, Entity, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn, DeleteDateColumn, JoinColumn, OneToMany } from "typeorm";

@Entity('ai_usage_quotas')
export class AiUsageQuota {
    @PrimaryGeneratedColumn('uuid')
    id : string;

    @Column({name : 'period_start'})
    periodStart : Date;

    @Column({name : 'period_end'})
    periodEnd : Date;

    @Column({name : 'quota_limit'})
    quotaLimit : number;

    @Column({name : 'quota_used', default: 0})
    quotaUsed : number;

    @Column({name : 'remaining_quota', default: 0})
    remainingQuota : number;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;

    @DeleteDateColumn({ name: 'deleted_at', nullable: true })
    deletedAt?: Date;

    @OneToOne(() => User, (user) => user.aiUsageQuota)
    @JoinColumn({ name: 'user_id' })
    user : User;

    @OneToMany(() => AiUsageLog , (aiUsageLog) => aiUsageLog.aiUsageQuota)
    aiUsageLogs : AiUsageLog[]
}
