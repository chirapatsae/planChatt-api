import { AiUsageQuota } from "src/ai-usage-quotas/entities/ai-usage-quota.entity";
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

@Entity('ai_usage_logs')
export class AiUsageLog {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'usage_type' })
    usageType: string

    @Column({ name: 'model_name' })
    modelName: string

    @Column({ name: 'input_tokens' })
    inputTokens: number

    @Column({ name: 'output_tokens' })
    outputTokens: number

    @Column({ name: 'input_text_length', nullable: true })
    inputTextLength: number

    @Column({ name: 'output_text_length', nullable: true })
    outputTextLength: number

    @Column({ name: 'cost_bath', type: 'decimal', precision: 12, scale: 4 })
    costBaht: number

    // Wave 36 N1 — endpoint discriminator. Values:
    //   'generate-project-detail' | 'regenerate-one-field'
    //   'pre-submit-review'       | 'land-use-classify'
    // Nullable to preserve backward compatibility with pre-Wave-36 rows.
    // Wave 36 N1 hotfix — declared with TS `?` optional modifier (not
    // `| null` required-nullable union) to avoid rippling the TypeORM
    // `_QueryDeepPartialEntity<T>` graph depth through related entities
    // (`User → AiUsageQuota → AiUsageLog[]`, `Attachment* → …`), which
    // otherwise causes downstream `Partial<User>` / `Partial<Attachment*>`
    // assignability errors in unrelated services. SQL semantics unchanged
    // — `nullable: true` still governs the DB column. Entity/DTO mocks
    // can omit these fields without typecheck failures.
    @Column({ name: 'endpoint', type: 'varchar', length: 64, nullable: true })
    endpoint?: string | null;

    @Column({ name: 'summary_th', type: 'text', nullable: true })
    summaryTh?: string | null;

    // jsonb columns typed as `any` rather than `Record<string, unknown>`
    // — TypeORM's `_QueryDeepPartialEntity<T>` recursion chokes on the
    // `Record<string, unknown>` shape when the entity is visited via
    // relation graphs (`User → AiUsageQuota → AiUsageLog[]`,
    // `Attachment* → ProjectGroup → …`), surfacing spurious
    // Partial<T> assignability errors in unrelated services.
    @Column({ name: 'request_payload', type: 'jsonb', nullable: true })
    requestPayload?: any;

    @Column({ name: 'response_payload', type: 'jsonb', nullable: true })
    responsePayload?: any;

    // SOFT reference to project-like entity (NO FK per §17.3). `target_kind`
    // enum at write-time: 'project_group' | 'revised_project_group' | 'supplement_project_group'
    @Column({ name: 'target_id', type: 'uuid', nullable: true })
    targetId?: string | null;

    @Column({ name: 'target_kind', type: 'varchar', length: 64, nullable: true })
    targetKind?: string | null;

    // Bare UUID, NO FK (§17.3 + Wave 13 opaque DTO).
    @Column({ name: 'actor_work_history_id', type: 'uuid', nullable: true })
    actorWorkHistoryId?: string | null;

    @Column({ name: 'duration_ms', type: 'integer', nullable: true })
    durationMs?: number | null;

    @Column({ name: 'error', type: 'text', nullable: true })
    error?: string | null;

    @CreateDateColumn({ name: 'used_at' })
    used_at: Date

    @ManyToOne(() => AiUsageQuota, (aiUsageQuota) => aiUsageQuota.aiUsageLogs)
    @JoinColumn({ name: 'ai_usage_quota_id' })
    aiUsageQuota: AiUsageQuota
}
