import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AiKnowledgeDomainMeta } from '../entities/ai-knowledge-domain-meta.entity';
import {
  COVERAGE_GAPS,
  CURATED_DOMAINS,
  KNOWLEDGE_DOMAINS,
} from '../registry/derived-domain-map';

/**
 * Wave wave-ai-knowledge-structure-mgmt — DB-01 (2026-06-13).
 *
 * StructureSeedService — the idempotent boot seed (Q-02) that imports the
 * CURRENT code registry into `ai_knowledge_domain_meta` so the executive
 * mind-map renders byte-identically the moment this wave ships
 * (architecture report §6.4 / DB-01 §3 idempotent-seed).
 *
 * What it seeds:
 *   - `KNOWLEDGE_DOMAINS` + `CURATED_DOMAINS` → `node_kind = 'domain'`
 *   - `COVERAGE_GAPS` → `node_kind = 'gap'`
 *
 * Idempotency (Q-02 / report §7.5 risk: "seed ทับข้อมูลที่แก้แล้ว"):
 *   - Inserts a row ONLY IF the `domain_key` is absent. An existing row
 *     (admin-edited or previously seeded) is NEVER overwritten — editing
 *     a label then rebooting does NOT revert it (DB-01 §7 acceptance).
 *   - Second boot performs zero inserts (count unchanged).
 *
 * Display fields seeded:
 *   - `display_order` follows the code declaration order so the day-one
 *     ring layout matches the pre-wave `/map` ordering.
 *   - Label-override columns are left NULL — the merge in BE-01 falls
 *     back to the code label when the override is NULL, so a NULL
 *     override is the identity (overlay-not-replacement, report §6.6).
 *   - Gap rows carry `gap_reason_th` from the code `reason`.
 *
 * Catalog seed is OUT OF SCOPE here (Q-02): importing tables/columns/
 * relations from real entities is a SEPARATE explicit admin action
 * (BE-03 `POST /structure/catalog/seed`), not a boot seed.
 *
 * Failure posture (mirrors `BackupLoginBootstrapService`): log loud,
 * NEVER crash boot — a seed hiccup must not take down the whole app, and
 * the safe code fallback keeps `/map` rendering regardless (report §6.4
 * safe-fallback).
 */
@Injectable()
export class StructureSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StructureSeedService.name);

  /**
   * System-actor sentinel for seed-written rows — the established nil
   * UUID used across the codebase for system-emitted (non-human) actions
   * (e.g. `ai-executive-chat` legacy sentinels). Plain uuid, NO FK
   * (§17.3 actor-by-UUID).
   */
  private static readonly SYSTEM_ACTOR_UUID =
    '00000000-0000-0000-0000-000000000000';

  constructor(
    @InjectRepository(AiKnowledgeDomainMeta)
    private readonly domainMetaRepository: Repository<AiKnowledgeDomainMeta>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedDomainMeta();
  }

  /** Insert any missing domain / gap overlay rows. Idempotent. */
  private async seedDomainMeta(): Promise<void> {
    try {
      type SeedRow = Pick<
        AiKnowledgeDomainMeta,
        | 'domainKey'
        | 'nodeKind'
        | 'displayOrder'
        | 'gapReasonTh'
        | 'createdByWorkHistoryId'
        | 'updatedByWorkHistoryId'
      >;

      const desired: SeedRow[] = [];
      let order = 0;

      // node_kind = 'domain' — derived first, then curated (the code
      // declaration order preserves the pre-wave ring layout).
      for (const domain of [...KNOWLEDGE_DOMAINS, ...CURATED_DOMAINS]) {
        desired.push({
          domainKey: domain.key,
          nodeKind: 'domain',
          displayOrder: order++,
          gapReasonTh: null,
          createdByWorkHistoryId: StructureSeedService.SYSTEM_ACTOR_UUID,
          updatedByWorkHistoryId: StructureSeedService.SYSTEM_ACTOR_UUID,
        });
      }

      // node_kind = 'gap'
      for (const gap of COVERAGE_GAPS) {
        desired.push({
          domainKey: gap.key,
          nodeKind: 'gap',
          displayOrder: order++,
          gapReasonTh: gap.reason ?? null,
          createdByWorkHistoryId: StructureSeedService.SYSTEM_ACTOR_UUID,
          updatedByWorkHistoryId: StructureSeedService.SYSTEM_ACTOR_UUID,
        });
      }

      // Existing keys — withDeleted so a soft-deleted gap is NOT
      // re-seeded (the seed never resurrects a key an admin removed).
      const keys = desired.map((row) => row.domainKey);
      const existing = await this.domainMetaRepository.find({
        select: { domainKey: true },
        where: { domainKey: In(keys) },
        withDeleted: true,
      });
      const existingKeys = new Set(existing.map((row) => row.domainKey));

      const toInsert = desired.filter(
        (row) => !existingKeys.has(row.domainKey),
      );

      if (toInsert.length === 0) {
        this.logger.log(
          '[KnowledgeStructure] domain_meta seed: nothing to insert (idempotent)',
        );
        return;
      }

      // Defense-in-depth against a concurrent boot: ON CONFLICT DO
      // NOTHING on the unique `domain_key` — a parallel insert wins
      // silently rather than throwing 23505.
      await this.domainMetaRepository
        .createQueryBuilder()
        .insert()
        .values(toInsert)
        .orIgnore()
        .execute();

      this.logger.log(
        `[KnowledgeStructure] domain_meta seed: inserted ${toInsert.length} row(s)`,
      );
    } catch (err) {
      this.logger.error(
        `[KnowledgeStructure] domain_meta seed failed (not crashing app): ${(err as Error).message}`,
      );
    }
  }
}
