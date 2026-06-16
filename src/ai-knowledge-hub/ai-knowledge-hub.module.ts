import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AiKnowledgeHubController } from './ai-knowledge-hub.controller';
import { AiKnowledgeHubService } from './ai-knowledge-hub.service';
import { KnowledgeIngestController } from './controllers/knowledge-ingest.controller';
// Wave wave-ai-knowledge-structure-mgmt — BE-01 (2026-06-13). Structure /
// catalog management surface (`/v1/ai-knowledge-hub/structure/*`). BE-01
// mounts the zero-write `GET /structure` aggregator; BE-02/03/04 mount
// their mutations here.
import { KnowledgeStructureController } from './controllers/knowledge-structure.controller';
import { KnowledgeSourceApiKeyGuard } from './guards/knowledge-source-api-key.guard';
import { KnowledgeIngestionRetentionCron } from './knowledge-ingestion-retention.cron';
import { KnowledgeAuditService } from './services/knowledge-audit.service';
import { KnowledgeIngestionService } from './services/knowledge-ingestion.service';
// Wave wave-ai-knowledge-structure-mgmt — BE-02 (2026-06-13). Class-A
// Phase-1 mutations (domain display-overlay PATCH + coverage-gap CRUD).
// Audits via KnowledgeAuditService; touches `ai_knowledge_domain_meta`
// only — NO project FK, NEVER TrackingStatus (§17.3).
import { KnowledgeStructureService } from './services/knowledge-structure.service';
// Wave wave-ai-knowledge-structure-mgmt — BE-03 (Phase 2, 2026-06-13).
// Class-A catalog table/column/relation CRUD + idempotent seed-from-entity
// import. Writes `ai_knowledge_catalog_*` ONLY; ABSOLUTE no-DDL; audits via
// KnowledgeAuditService; NO project FK, NEVER TrackingStatus (§17.3).
import { KnowledgeCatalogService } from './services/knowledge-catalog.service';
// Wave wave-ai-knowledge-structure-mgmt — BE-04 (Phase 3, 2026-06-13).
// Class-B tool↔domain binding override + runtime bijection guard (super-
// admin only, Q-04). Writes `ai_knowledge_tool_binding` ONLY; audits via
// KnowledgeAuditService; NO project FK, NEVER TrackingStatus (§17.3).
import { KnowledgeToolBindingService } from './services/knowledge-tool-binding.service';
import { KnowledgeSearchService } from './services/knowledge-search.service';
import { KnowledgeSourceService } from './services/knowledge-source.service';
import { StructureSeedService } from './services/structure-seed.service';
import { AiKnowledgeAuditLog } from './entities/ai-knowledge-audit-log.entity';
import { AiKnowledgeEntry } from './entities/ai-knowledge-entry.entity';
import { AiKnowledgeEntryRevision } from './entities/ai-knowledge-entry-revision.entity';
import { AiKnowledgeIngestion } from './entities/ai-knowledge-ingestion.entity';
import { AiKnowledgeSource } from './entities/ai-knowledge-source.entity';
// Wave wave-ai-knowledge-structure-mgmt — DB-01 (2026-06-13). Class-A
// structure / catalog overlay entities + Phase-3 tool-binding override.
// All ai_* namespace; the only FKs are ai_* → ai_* (catalog columns /
// relations → catalog tables); NO FK into any project table (§17.3).
import { AiKnowledgeCatalogColumn } from './entities/ai-knowledge-catalog-column.entity';
import { AiKnowledgeCatalogRelation } from './entities/ai-knowledge-catalog-relation.entity';
import { AiKnowledgeCatalogTable } from './entities/ai-knowledge-catalog-table.entity';
import { AiKnowledgeDomainMeta } from './entities/ai-knowledge-domain-meta.entity';
import { AiKnowledgeToolBinding } from './entities/ai-knowledge-tool-binding.entity';
// BE-01 — `WorkStatusApprovedGuard` on the map endpoint injects
// `Repository<WorkHistory>`; it must be registered with `forFeature`
// in the consuming module (same wiring as `ai-executive-chat.module.ts`).
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

/**
 * Wave wave-ai-knowledge-hub — DB-01 + DB-02 + BE-01 (2026-06-12).
 *
 * AI Knowledge Hub module — sibling of `ai-executive-chat` /
 * `ai-usage-quotas` (architecture report §2.5; wave decision #4: this
 * module does NOT import `ai-executive-chat` internals — the only
 * cross-module imports are the PUBLIC tool-registry seam
 * (`EXECUTIVE_TOOL_REGISTRY` / `EXECUTIVE_TOOL_NAMES` / types, read-only
 * per §17.15.2(a)); BE-04 will hook the `searchKnowledgeBase` tool in
 * via the same public registration seam).
 *
 * DB-01 / DB-02 registered the entities so `synchronize:true` creates
 * the three Phase-1 `ai_knowledge_*` tables (entries / revisions /
 * audit logs) and the two Phase-2 connector tables (sources /
 * quarantined ingestions). BE-01 adds the map read aggregator
 * (`GET /v1/ai-knowledge-hub/map` — zero-write, EXEC_READ per
 * §17.15.6). BE-02 (curated CRUD + audit) and BE-03 (connector
 * registry + ingest + quarantine review) extend this module next.
 * `TypeOrmModule` is exported so sibling tasks can inject the
 * repositories without re-registering the entities;
 * `AiKnowledgeHubService` is exported for the BE-04 tool handler.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AiKnowledgeEntry,
      AiKnowledgeEntryRevision,
      AiKnowledgeAuditLog,
      AiKnowledgeSource,
      AiKnowledgeIngestion,
      // Wave wave-ai-knowledge-structure-mgmt — DB-01: structure /
      // catalog overlay + tool-binding override (registered so
      // synchronize:true creates the 5 tables; consumed by BE-01..BE-04).
      AiKnowledgeDomainMeta,
      AiKnowledgeCatalogTable,
      AiKnowledgeCatalogColumn,
      AiKnowledgeCatalogRelation,
      AiKnowledgeToolBinding,
      // `WorkStatusApprovedGuard` loads the caller's current WorkHistory
      // (live §2 workStatus check) — guard-only registration, no hub
      // entity relation is introduced (§17.3 stays intact: no FK from
      // ai_knowledge_* into any app table).
      WorkHistory,
    ]),
  ],
  controllers: [
    AiKnowledgeHubController,
    KnowledgeIngestController,
    KnowledgeStructureController,
  ],
  // BE-02 — `KnowledgeAuditService` is the single `ai_knowledge_audit_logs`
  // writer (§17.3); exported so BE-03 reuses it for promote / reject /
  // source_* audit actions.
  // BE-04 — `KnowledgeSearchService` is the published-only retrieval
  // backend of the `searchKnowledgeBase` executive tool; exported so
  // `AiExecutiveChatModule` can consume it (one-way dependency
  // chat → hub per wave decision #4 — this module still never imports
  // `ai-executive-chat` internals beyond the public registry seam).
  // BE-03 — connector pipeline: `KnowledgeSourceService` (lifecycle +
  // ingest authentication), `KnowledgeIngestionService` (quarantine
  // staging + review), `KnowledgeSourceApiKeyGuard` (the ONLY gate on
  // the ingest route — no JWT), and the PDPA staging retention cron
  // (daily 03:30 Asia/Bangkok; §17.15.5).
  providers: [
    AiKnowledgeHubService,
    KnowledgeAuditService,
    KnowledgeSearchService,
    KnowledgeSourceService,
    KnowledgeIngestionService,
    KnowledgeSourceApiKeyGuard,
    KnowledgeIngestionRetentionCron,
    // Wave wave-ai-knowledge-structure-mgmt — DB-01: idempotent boot seed
    // (Q-02) importing the code registry into `ai_knowledge_domain_meta`
    // so `GET /map` renders byte-identically day one.
    StructureSeedService,
    // BE-02: Class-A domain/gap display-overlay mutations (Phase 1).
    KnowledgeStructureService,
    // BE-03: Class-A catalog table/column/relation CRUD + seed (Phase 2).
    KnowledgeCatalogService,
    // BE-04: Class-B tool-binding override + runtime bijection (Phase 3).
    KnowledgeToolBindingService,
  ],
  exports: [
    TypeOrmModule,
    AiKnowledgeHubService,
    KnowledgeAuditService,
    KnowledgeSearchService,
  ],
})
export class AiKnowledgeHubModule {}
