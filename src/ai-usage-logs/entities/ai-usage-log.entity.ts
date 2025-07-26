import { AiUsageQuota } from "src/ai-usage-quotas/entities/ai-usage-quota.entity";
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

@Entity('ai_usage_logs')
export class AiUsageLog {
    @PrimaryGeneratedColumn('uuid')
    id : string;
    
    @Column({name : 'usage_type'})
    usageType : string

    @Column({name : 'input_text_length'})
    inputTextLength : number

    @Column({name : 'output_text_length'})
    outputTextLength : number

    @Column({name : 'cost_bath'})
    costBaht : number

    @CreateDateColumn({name : 'used_at'})
    used_at : Date

    @ManyToOne(() => AiUsageQuota , (aiUsageQuota) => aiUsageQuota.aiUsageLogs)
    @JoinColumn({name : 'ai_usage_quota_id'})
    aiUsageQuota : AiUsageQuota
}
