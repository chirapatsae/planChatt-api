import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';

import {
  CreateCatalogTableDto,
  UpdateCatalogTableDto,
} from '../dto/catalog-table.dto';
import { UpsertCatalogColumnsDto } from '../dto/catalog-column.dto';
import {
  CreateCatalogRelationDto,
  UpdateCatalogRelationDto,
} from '../dto/catalog-relation.dto';
import { AiKnowledgeCatalogColumn } from '../entities/ai-knowledge-catalog-column.entity';
import { AiKnowledgeCatalogRelation } from '../entities/ai-knowledge-catalog-relation.entity';
import { AiKnowledgeCatalogTable } from '../entities/ai-knowledge-catalog-table.entity';
import { KnowledgeAuditService } from './knowledge-audit.service';

/** Resolved acting admin — WorkHistory uuid + role name at action time. */
interface KnowledgeCatalogActor {
  workHistoryId: string;
  roleName: string;
}

/** Response shape for a catalog-table create / update. */
export interface CatalogTableDto {
  id: string;
  tableName: string;
  displayNameTh: string;
  descriptionTh: string | null;
  domainKey: string | null;
  isSeeded: boolean;
  displayOrder: number;
}

/** Response shape for a single catalog column (nested in the upsert result). */
export interface CatalogColumnDto {
  id: string;
  columnName: string;
  dataType: string | null;
  isNullable: boolean;
  descriptionTh: string | null;
  isPii: boolean;
  displayOrder: number;
}

/** Result of the bulk column upsert — the resulting live set + a diff summary. */
export interface CatalogColumnUpsertResultDto {
  tableId: string;
  columns: CatalogColumnDto[];
  diff: {
    inserted: string[];
    updated: string[];
    deleted: string[];
  };
}

/** Response shape for a catalog-relation create / update. */
export interface CatalogRelationDto {
  id: string;
  fromTableId: string;
  toTableId: string;
  relationType: string;
  labelTh: string | null;
  onDeleteNote: string | null;
  displayOrder: number;
}

/** Result of a catalog-table soft-delete (with the service cascade summary). */
export interface CatalogTableDeleteResultDto {
  id: string;
  softDeleted: true;
  /** Count of columns soft-deleted by the service cascade (NOT a DB CASCADE). */
  columnsSoftDeleted: number;
  /** Count of dangling relations soft-deleted by the service cascade. */
  relationsSoftDeleted: number;
}

/** Result of a catalog-relation soft-delete. */
export interface CatalogRelationDeleteResultDto {
  id: string;
  softDeleted: true;
}

/** Result of the idempotent seed-from-entity import (Q-02). */
export interface CatalogSeedResultDto {
  /** Catalog tables inserted on this run. */
  tablesInserted: number;
  /** Catalog columns inserted on this run. */
  columnsInserted: number;
  /** Table names skipped because a live catalog row already exists (idempotent). */
  skippedTableNames: string[];
}

/**
 * Wave wave-ai-knowledge-structure-mgmt — BE-03 (Phase 2, 2026-06-13).
 *
 * KnowledgeCatalogService — Phase-2 Class-A MUTATIONS for the data-catalog
 * (topic iii: tables + columns) and the ER builder (topic iv:
 * relationships). All writes go through TypeORM repository methods on the
 * `ai_knowledge_catalog_*` entities ONLY.
 *
 * ABSOLUTE NO-DDL GUARANTEE (CTO decision #2 / report §6.3 / DOCS-01
 * §17.16.3 — CRITICAL):
 *
 *   - This service NEVER runs `CREATE` / `ALTER` / `DROP` / raw DDL. It
 *     NEVER calls `createQueryRunner().createTable|dropTable|addColumn`, a
 *     schema builder, or `query(rawDDL)`. The catalog is a DOCUMENTATION
 *     overlay.
 *   - `tableName` / `columnName` / `dataType` / `onDeleteNote` are PLAIN
 *     `varchar` TEXT. They are never SQL identifiers, never concatenated
 *     into a query, and never round-trip to the real Postgres schema.
 *   - The seed (Q-02) reads `DataSource.entityMetadatas` (`getMetadata`)
 *     READ-ONLY and inserts catalog DATA rows — it never alters anything.
 *   - SEC-01 / `no-ddl-guard.spec.ts` static-greps this file for DDL verbs
 *     and asserts zero matches; this service stays clean for that spec.
 *
 * CLAUDE.md references:
 *   - §17.2 — every field here is advisory DOCUMENTATION; nothing gates a
 *     workflow transition, ownership, or permission.
 *   - §17.3 — mutations audit via `ai_knowledge_audit_logs`
 *     (`catalog_table_* / catalog_column_* / relation_*`) and NEVER
 *     TrackingStatus. Actors referenced by WorkHistory uuid WITHOUT
 *     referential integrity. NO FK into any project table — the only FKs
 *     are `ai_* → ai_*` (columns / relations → catalog tables).
 *   - §17.11 — no role exemption: the no-DDL / no-project-FK invariants are
 *     INTEGRITY guarantees, not permission gates; no role (super-admin
 *     included) may bypass them.
 *   - §17.16 (DOCS-01) — Class A scope, No-DDL guarantee, storage rule.
 *
 * Transaction + audit contract (task §6): every mutation runs inside a
 * single transaction and writes EXACTLY ONE audit row (or one batch row
 * for the column upsert / seed) through the shared `KnowledgeAuditService`
 * on the caller's transactional `manager`, so audit commits / rolls back
 * atomically with the mutation.
 */
@Injectable()
export class KnowledgeCatalogService {
  constructor(
    @InjectRepository(AiKnowledgeCatalogTable)
    private readonly tableRepository: Repository<AiKnowledgeCatalogTable>,
    @InjectRepository(AiKnowledgeCatalogColumn)
    private readonly columnRepository: Repository<AiKnowledgeCatalogColumn>,
    @InjectRepository(AiKnowledgeCatalogRelation)
    private readonly relationRepository: Repository<AiKnowledgeCatalogRelation>,
    /**
     * Actor resolution per §4 / §17.3 — every mutation records the acting
     * admin's CURRENT WorkHistory uuid + denormalized role name.
     */
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
    /** The single `ai_knowledge_audit_logs` writer (§17.3). */
    private readonly knowledgeAuditService: KnowledgeAuditService,
    /**
     * READ-ONLY metadata source for the Q-02 seed. Only `entityMetadatas`
     * / `getMetadata` are read; no `createQueryRunner` / schema-builder /
     * raw DDL is ever issued through this handle (no-DDL guarantee).
     */
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  // Topic (iii) — catalog table CRUD
  // ──────────────────────────────────────────────────────────────────

  /**
   * `POST /structure/catalog/tables` — create a catalog table row (admin +
   * super-admin, Q-03). `tableName` is plain documentation text (no-DDL);
   * a collision with a LIVE row → `409 CATALOG_TABLE_NAME_DUPLICATE`.
   * Audits `catalog_table_create`.
   */
  async createTable(
    dto: CreateCatalogTableDto,
    userId: string,
  ): Promise<CatalogTableDto> {
    const actor = await this.resolveActor(userId);

    return this.tableRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AiKnowledgeCatalogTable);
      await this.assertTableNameAvailable(dto.tableName, null, repo);

      const saved = await repo.save(
        repo.create({
          tableName: dto.tableName,
          displayNameTh: dto.displayNameTh,
          descriptionTh: dto.descriptionTh ?? null,
          domainKey: dto.domainKey ?? null,
          isSeeded: false,
          displayOrder: dto.displayOrder ?? 0,
          createdByWorkHistoryId: actor.workHistoryId,
          updatedByWorkHistoryId: actor.workHistoryId,
        }),
      );

      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'catalog_table_create',
          targetKind: 'catalog_table',
          targetId: saved.id,
          detail: { tableName: saved.tableName, domainKey: saved.domainKey },
        },
        manager,
      );

      return this.toTableDto(saved);
    });
  }

  /**
   * `PATCH /structure/catalog/tables/:id` — edit display fields (admin +
   * super-admin, Q-03). A non-existent / soft-deleted id →
   * `404 CATALOG_TABLE_NOT_FOUND`. A rename collision with another LIVE
   * row → `409 CATALOG_TABLE_NAME_DUPLICATE`. Audits `catalog_table_update`.
   */
  async updateTable(
    id: string,
    dto: UpdateCatalogTableDto,
    userId: string,
  ): Promise<CatalogTableDto> {
    const actor = await this.resolveActor(userId);

    return this.tableRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AiKnowledgeCatalogTable);
      const existing = await repo.findOne({
        where: { id, deletedAt: IsNull() },
      });
      if (!existing) throw this.tableNotFound(id);

      if (dto.tableName !== undefined && dto.tableName !== existing.tableName) {
        await this.assertTableNameAvailable(dto.tableName, id, repo);
      }

      const changedFields = this.collectChangedTableFields(dto, existing);
      this.applyTablePatch(existing, dto);
      existing.updatedByWorkHistoryId = actor.workHistoryId;
      const saved = await repo.save(existing);

      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'catalog_table_update',
          targetKind: 'catalog_table',
          targetId: saved.id,
          detail: { tableName: saved.tableName, changedFields },
        },
        manager,
      );

      return this.toTableDto(saved);
    });
  }

  /**
   * `DELETE /structure/catalog/tables/:id` — soft-delete a catalog table
   * (admin + super-admin, Q-03).
   *
   * SERVICE CASCADE (NOT a DB CASCADE that hard-deletes — task §3 / §8):
   * soft-delete the table's live columns AND every live relation touching
   * it (from OR to), so the ER view never dangles. The audit row is written
   * BEFORE the `deletedAt` flips (tombstone-before-delete, §12 / §17.3).
   * Audits `catalog_table_delete`.
   */
  async deleteTable(
    id: string,
    userId: string,
  ): Promise<CatalogTableDeleteResultDto> {
    const actor = await this.resolveActor(userId);

    return this.tableRepository.manager.transaction(async (manager) => {
      const tableRepo = manager.getRepository(AiKnowledgeCatalogTable);
      const columnRepo = manager.getRepository(AiKnowledgeCatalogColumn);
      const relationRepo = manager.getRepository(AiKnowledgeCatalogRelation);

      const existing = await tableRepo.findOne({
        where: { id, deletedAt: IsNull() },
      });
      if (!existing) throw this.tableNotFound(id);

      const liveColumns = await columnRepo.find({
        where: { tableId: id, deletedAt: IsNull() },
      });
      // Live relations where this table is EITHER end (two scoped queries —
      // an OR across two FK columns; both still `deletedAt IS NULL`).
      const relationsFrom = await relationRepo.find({
        where: { fromTableId: id, deletedAt: IsNull() },
      });
      const relationsTo = await relationRepo.find({
        where: { toTableId: id, deletedAt: IsNull() },
      });
      const danglingRelationIds = new Set<string>([
        ...relationsFrom.map((rel) => rel.id),
        ...relationsTo.map((rel) => rel.id),
      ]);

      // Tombstone audit row BEFORE any soft-delete (§12 / §17.3).
      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'catalog_table_delete',
          targetKind: 'catalog_table',
          targetId: existing.id,
          detail: {
            tableName: existing.tableName,
            cascadeColumns: liveColumns.length,
            cascadeRelations: danglingRelationIds.size,
          },
        },
        manager,
      );

      // Service cascade — soft-delete children + dangling relations first,
      // then the table itself. softDelete sets `deleted_at`; the DB FK has
      // onDelete CASCADE only for HARD deletes, which never occur here.
      if (liveColumns.length > 0) {
        await columnRepo.softDelete(liveColumns.map((col) => col.id));
      }
      if (danglingRelationIds.size > 0) {
        await relationRepo.softDelete([...danglingRelationIds]);
      }
      await tableRepo.softDelete({ id });

      return {
        id,
        softDeleted: true,
        columnsSoftDeleted: liveColumns.length,
        relationsSoftDeleted: danglingRelationIds.size,
      };
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Topic (iii) — catalog column bulk upsert
  // ──────────────────────────────────────────────────────────────────

  /**
   * `PUT /structure/catalog/tables/:id/columns` — bulk replace the column
   * set for a table (admin + super-admin, Q-03).
   *
   * Diff (keyed by `columnName` — the live `(table_id, column_name)` pair):
   *   - body + existing → UPDATE in place (re-position to the body order)
   *   - body only       → INSERT
   *   - existing only    → SOFT-DELETE
   * A duplicate `columnName` within the body → `400 CATALOG_COLUMN_DUPLICATE`
   * (the live unique `(table_id, column_name)` cannot hold two). A
   * non-existent / soft-deleted parent table → `404 CATALOG_TABLE_NOT_FOUND`.
   * Audits ONE batch `catalog_column_upsert` row with a diff summary.
   */
  async upsertColumns(
    tableId: string,
    dto: UpsertCatalogColumnsDto,
    userId: string,
  ): Promise<CatalogColumnUpsertResultDto> {
    const actor = await this.resolveActor(userId);
    this.assertNoDuplicateColumnNames(dto.columns.map((col) => col.columnName));

    return this.tableRepository.manager.transaction(async (manager) => {
      const tableRepo = manager.getRepository(AiKnowledgeCatalogTable);
      const columnRepo = manager.getRepository(AiKnowledgeCatalogColumn);

      const table = await tableRepo.findOne({
        where: { id: tableId, deletedAt: IsNull() },
      });
      if (!table) throw this.tableNotFound(tableId);

      const existingColumns = await columnRepo.find({
        where: { tableId, deletedAt: IsNull() },
      });
      const existingByName = new Map(
        existingColumns.map((col) => [col.columnName, col]),
      );
      const incomingNames = new Set(
        dto.columns.map((col) => col.columnName),
      );

      const inserted: string[] = [];
      const updated: string[] = [];
      const deleted: string[] = [];

      const toSave: AiKnowledgeCatalogColumn[] = [];

      dto.columns.forEach((input, index) => {
        const order = input.displayOrder ?? index;
        const existing = existingByName.get(input.columnName);
        if (existing) {
          existing.dataType = input.dataType ?? null;
          existing.isNullable = input.isNullable ?? true;
          existing.descriptionTh = input.descriptionTh ?? null;
          existing.isPii = input.isPii ?? false;
          existing.displayOrder = order;
          toSave.push(existing);
          updated.push(input.columnName);
        } else {
          toSave.push(
            columnRepo.create({
              tableId,
              columnName: input.columnName,
              dataType: input.dataType ?? null,
              isNullable: input.isNullable ?? true,
              descriptionTh: input.descriptionTh ?? null,
              isPii: input.isPii ?? false,
              displayOrder: order,
            }),
          );
          inserted.push(input.columnName);
        }
      });

      const toDeleteIds: string[] = [];
      for (const existing of existingColumns) {
        if (!incomingNames.has(existing.columnName)) {
          toDeleteIds.push(existing.id);
          deleted.push(existing.columnName);
        }
      }

      // Audit BEFORE the writes (one batch row — diff summary in detail).
      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'catalog_column_upsert',
          targetKind: 'catalog_column',
          // Batch row — the target is the parent table; the diff IS the
          // payload (mirrors the BE-02 reorder batch-row convention).
          targetId: tableId,
          detail: {
            batchUpsert: true,
            inserted,
            updated,
            deleted,
          },
        },
        manager,
      );

      if (toSave.length > 0) await columnRepo.save(toSave);
      if (toDeleteIds.length > 0) await columnRepo.softDelete(toDeleteIds);

      const liveColumns = await columnRepo.find({
        where: { tableId, deletedAt: IsNull() },
        order: { displayOrder: 'ASC', columnName: 'ASC' },
      });

      return {
        tableId,
        columns: liveColumns.map((col) => this.toColumnDto(col)),
        diff: { inserted, updated, deleted },
      };
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Topic (iv) — relationship (ER) CRUD
  // ──────────────────────────────────────────────────────────────────

  /**
   * `POST /structure/catalog/relations` — create an ER edge (admin +
   * super-admin, Q-03).
   *
   * Validation (task §7 relation integrity):
   *   - both ids reference LIVE catalog tables → else
   *     `400 CATALOG_RELATION_TABLE_INVALID` (relating a soft-deleted
   *     table is rejected).
   *   - `fromTableId === toTableId` rejected unless `allowSelf` →
   *     `400 CATALOG_RELATION_SELF_LOOP`.
   *   - `relationType` is required (enforced at the DTO).
   * Audits `relation_create`.
   */
  async createRelation(
    dto: CreateCatalogRelationDto,
    userId: string,
  ): Promise<CatalogRelationDto> {
    const actor = await this.resolveActor(userId);

    if (dto.fromTableId === dto.toTableId && !dto.allowSelf) {
      throw new BadRequestException({
        code: 'CATALOG_RELATION_SELF_LOOP',
        message:
          'ไม่สามารถสร้างความสัมพันธ์ไปยังตารางเดียวกันได้ (self-loop) เว้นแต่ระบุ allowSelf',
      });
    }

    return this.relationRepository.manager.transaction(async (manager) => {
      const tableRepo = manager.getRepository(AiKnowledgeCatalogTable);
      const relationRepo = manager.getRepository(AiKnowledgeCatalogRelation);

      await this.assertLiveTable(dto.fromTableId, 'fromTableId', tableRepo);
      await this.assertLiveTable(dto.toTableId, 'toTableId', tableRepo);

      const saved = await relationRepo.save(
        relationRepo.create({
          fromTableId: dto.fromTableId,
          toTableId: dto.toTableId,
          relationType: dto.relationType,
          labelTh: dto.labelTh ?? null,
          onDeleteNote: dto.onDeleteNote ?? null,
          displayOrder: dto.displayOrder ?? 0,
        }),
      );

      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'relation_create',
          targetKind: 'relation',
          targetId: saved.id,
          detail: {
            fromTableId: saved.fromTableId,
            toTableId: saved.toTableId,
            relationType: saved.relationType,
          },
        },
        manager,
      );

      return this.toRelationDto(saved);
    });
  }

  /**
   * `PATCH /structure/catalog/relations/:id` — edit type / label / note /
   * order (admin + super-admin, Q-03). A non-existent / soft-deleted id →
   * `404 CATALOG_RELATION_NOT_FOUND`. Endpoints CANNOT re-point the table
   * ids (a re-point is a delete + create) — the DTO omits them. Audits
   * `relation_update`.
   */
  async updateRelation(
    id: string,
    dto: UpdateCatalogRelationDto,
    userId: string,
  ): Promise<CatalogRelationDto> {
    const actor = await this.resolveActor(userId);

    return this.relationRepository.manager.transaction(async (manager) => {
      const relationRepo = manager.getRepository(AiKnowledgeCatalogRelation);
      const existing = await relationRepo.findOne({
        where: { id, deletedAt: IsNull() },
      });
      if (!existing) throw this.relationNotFound(id);

      const changedFields = this.collectChangedRelationFields(dto, existing);
      if (dto.relationType !== undefined) {
        existing.relationType = dto.relationType;
      }
      if (dto.labelTh !== undefined) existing.labelTh = dto.labelTh;
      if (dto.onDeleteNote !== undefined) {
        existing.onDeleteNote = dto.onDeleteNote;
      }
      if (dto.displayOrder !== undefined) {
        existing.displayOrder = dto.displayOrder;
      }
      const saved = await relationRepo.save(existing);

      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'relation_update',
          targetKind: 'relation',
          targetId: saved.id,
          detail: { changedFields },
        },
        manager,
      );

      return this.toRelationDto(saved);
    });
  }

  /**
   * `DELETE /structure/catalog/relations/:id` — soft-delete an ER edge
   * (admin + super-admin, Q-03). A non-existent / already-deleted id →
   * `404 CATALOG_RELATION_NOT_FOUND`. The audit row is written BEFORE the
   * `deletedAt` flips. Audits `relation_delete`.
   */
  async deleteRelation(
    id: string,
    userId: string,
  ): Promise<CatalogRelationDeleteResultDto> {
    const actor = await this.resolveActor(userId);

    return this.relationRepository.manager.transaction(async (manager) => {
      const relationRepo = manager.getRepository(AiKnowledgeCatalogRelation);
      const existing = await relationRepo.findOne({
        where: { id, deletedAt: IsNull() },
      });
      if (!existing) throw this.relationNotFound(id);

      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'relation_delete',
          targetKind: 'relation',
          targetId: existing.id,
          detail: {
            fromTableId: existing.fromTableId,
            toTableId: existing.toTableId,
          },
        },
        manager,
      );

      await relationRepo.softDelete({ id });

      return { id, softDeleted: true };
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Seed-from-entity (Q-02) — one-shot, idempotent, READ-ONLY metadata
  // ──────────────────────────────────────────────────────────────────

  /**
   * `POST /structure/catalog/seed` — one-shot, idempotent import (Q-02,
   * admin + super-admin).
   *
   * Reads `DataSource.entityMetadatas` READ-ONLY (NO DDL, NO schema touch)
   * and inserts a catalog table (+ its columns) as DATA rows
   * (`is_seeded = true`) for any `table_name` not already present as a LIVE
   * catalog row. Existing rows — hand-curated OR previously seeded — are
   * SKIPPED by `(table_name)`, so a second run inserts zero duplicates and
   * never clobbers an admin's edits (task §6 / §8 idempotency).
   *
   * NO-DDL: `metadata.tableName` / `column.databaseName` / `column.type`
   * are mapped to plain `varchar` catalog text — they are never used as SQL
   * identifiers and never round-trip to alter the schema.
   */
  async seedFromEntities(userId: string): Promise<CatalogSeedResultDto> {
    const actor = await this.resolveActor(userId);

    // Build the desired set from in-memory metadata (read-only). Skip
    // junction tables (no own entity class) and entities excluded from
    // synchronize (views / external) — they are not first-class app tables.
    const desired = this.dataSource.entityMetadatas
      .filter((meta) => meta.synchronize && meta.tableType === 'regular')
      .map((meta) => ({
        tableName: meta.tableName,
        columns: meta.columns.map((col, index) => ({
          columnName: col.databaseName,
          dataType: this.describeColumnType(col),
          isNullable: col.isNullable,
          descriptionTh: col.comment ?? null,
          displayOrder: index,
        })),
      }))
      // De-dup by tableName defensively (shouldn't happen for regular
      // entities, but a single-table-inheritance base could repeat).
      .filter(
        (meta, index, all) =>
          all.findIndex((other) => other.tableName === meta.tableName) ===
          index,
      );

    return this.tableRepository.manager.transaction(async (manager) => {
      const tableRepo = manager.getRepository(AiKnowledgeCatalogTable);
      const columnRepo = manager.getRepository(AiKnowledgeCatalogColumn);

      // Existing LIVE catalog names — the idempotency key is `(table_name)`
      // where `deleted_at IS NULL` (matches the partial unique index).
      const existing = await tableRepo.find({
        select: { tableName: true },
        where: { deletedAt: IsNull() },
      });
      const existingNames = new Set(existing.map((row) => row.tableName));

      let tablesInserted = 0;
      let columnsInserted = 0;
      const skippedTableNames: string[] = [];
      const insertedTableNames: string[] = [];

      for (const meta of desired) {
        if (existingNames.has(meta.tableName)) {
          skippedTableNames.push(meta.tableName);
          continue;
        }

        const savedTable = await tableRepo.save(
          tableRepo.create({
            tableName: meta.tableName,
            displayNameTh: meta.tableName,
            descriptionTh: null,
            domainKey: null,
            isSeeded: true,
            displayOrder: 0,
            createdByWorkHistoryId: actor.workHistoryId,
            updatedByWorkHistoryId: actor.workHistoryId,
          }),
        );
        tablesInserted += 1;
        insertedTableNames.push(meta.tableName);

        if (meta.columns.length > 0) {
          const cols = meta.columns.map((col) =>
            columnRepo.create({
              tableId: savedTable.id,
              columnName: col.columnName,
              dataType: col.dataType,
              isNullable: col.isNullable,
              descriptionTh: col.descriptionTh,
              isPii: false,
              displayOrder: col.displayOrder,
            }),
          );
          await columnRepo.save(cols);
          columnsInserted += cols.length;
        }
      }

      // ONE batch audit row for the whole import (task §3 seed: "batch
      // row"); reuse `catalog_table_create` with a seed-batch detail.
      await this.knowledgeAuditService.record(
        {
          actorWorkHistoryId: actor.workHistoryId,
          actorRole: actor.roleName,
          action: 'catalog_table_create',
          targetKind: 'catalog_table',
          // No single target — the batch import IS the payload; nil-uuid
          // sentinel (mirrors the BE-02 reorder batch row).
          targetId: '00000000-0000-0000-0000-000000000000',
          detail: {
            seedBatch: true,
            tablesInserted,
            columnsInserted,
            insertedTableNames,
            skippedCount: skippedTableNames.length,
          },
        },
        manager,
      );

      return { tablesInserted, columnsInserted, skippedTableNames };
    });
  }

  // ── private helpers ──────────────────────────────────────────────

  /**
   * Resolve the acting admin's CURRENT WorkHistory (§4 source of truth) —
   * uuid for the audit trail + role name denormalized at action time. The
   * guard chain has already admitted the caller; this is the §17.3
   * actor-identity read, not a second permission gate.
   */
  private async resolveActor(userId: string): Promise<KnowledgeCatalogActor> {
    if (!userId) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }
    const workHistory = await this.workHistoryRepository.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['role'],
    });
    if (!workHistory) {
      throw new ForbiddenException('WORK_STATUS_NOT_APPROVED');
    }
    return {
      workHistoryId: workHistory.id,
      roleName: workHistory.role?.name ?? '',
    };
  }

  /**
   * Assert no LIVE catalog table already carries `tableName` (excluding
   * `excludeId` on a rename). Mirrors the partial unique
   * `(table_name) WHERE deleted_at IS NULL` at the service layer →
   * `409 CATALOG_TABLE_NAME_DUPLICATE`.
   */
  private async assertTableNameAvailable(
    tableName: string,
    excludeId: string | null,
    repo: Repository<AiKnowledgeCatalogTable>,
  ): Promise<void> {
    const clash = await repo.findOne({
      where: { tableName, deletedAt: IsNull() },
    });
    if (clash && clash.id !== excludeId) {
      throw new ConflictException({
        code: 'CATALOG_TABLE_NAME_DUPLICATE',
        message: 'มีตารางชื่อนี้ในแค็ตตาล็อกอยู่แล้ว กรุณาใช้ชื่ออื่น',
        tableName,
      });
    }
  }

  /**
   * Assert the catalog table `id` is LIVE (exists, not soft-deleted) —
   * a relation MUST NOT touch a soft-deleted table (task §7). →
   * `400 CATALOG_RELATION_TABLE_INVALID`.
   */
  private async assertLiveTable(
    id: string,
    field: 'fromTableId' | 'toTableId',
    repo: Repository<AiKnowledgeCatalogTable>,
  ): Promise<void> {
    const table = await repo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!table) {
      throw new BadRequestException({
        code: 'CATALOG_RELATION_TABLE_INVALID',
        message:
          'ไม่สามารถสร้างความสัมพันธ์กับตารางที่ไม่พบหรือถูกลบไปแล้ว',
        field,
        id,
      });
    }
  }

  /** A column-name appearing twice in the upsert body breaks the live unique. */
  private assertNoDuplicateColumnNames(names: string[]): void {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) {
        throw new BadRequestException({
          code: 'CATALOG_COLUMN_DUPLICATE',
          message: 'มีชื่อคอลัมน์ซ้ำในรายการที่ส่งมา กรุณาตรวจสอบ',
          columnName: name,
        });
      }
      seen.add(name);
    }
  }

  /** Apply the merge-patch onto an existing table row in place. */
  private applyTablePatch(
    row: AiKnowledgeCatalogTable,
    dto: UpdateCatalogTableDto,
  ): void {
    if (dto.tableName !== undefined) row.tableName = dto.tableName;
    if (dto.displayNameTh !== undefined) row.displayNameTh = dto.displayNameTh;
    if (dto.descriptionTh !== undefined) row.descriptionTh = dto.descriptionTh;
    if (dto.domainKey !== undefined) row.domainKey = dto.domainKey;
    if (dto.displayOrder !== undefined) row.displayOrder = dto.displayOrder;
  }

  /** Diff summary for the `catalog_table_update` audit `detail`. */
  private collectChangedTableFields(
    dto: UpdateCatalogTableDto,
    existing: AiKnowledgeCatalogTable,
  ): string[] {
    const fields: string[] = [];
    const consider = (
      name: keyof UpdateCatalogTableDto,
      currentValue: unknown,
    ): void => {
      if (dto[name] === undefined) return;
      if (dto[name] !== currentValue) fields.push(name);
    };
    consider('tableName', existing.tableName);
    consider('displayNameTh', existing.displayNameTh);
    consider('descriptionTh', existing.descriptionTh);
    consider('domainKey', existing.domainKey);
    consider('displayOrder', existing.displayOrder);
    return fields;
  }

  /** Diff summary for the `relation_update` audit `detail`. */
  private collectChangedRelationFields(
    dto: UpdateCatalogRelationDto,
    existing: AiKnowledgeCatalogRelation,
  ): string[] {
    const fields: string[] = [];
    const consider = (
      name: keyof UpdateCatalogRelationDto,
      currentValue: unknown,
    ): void => {
      if (dto[name] === undefined) return;
      if (dto[name] !== currentValue) fields.push(name);
    };
    consider('relationType', existing.relationType);
    consider('labelTh', existing.labelTh);
    consider('onDeleteNote', existing.onDeleteNote);
    consider('displayOrder', existing.displayOrder);
    return fields;
  }

  /**
   * Render a column's database type as PLAIN documentation text — e.g.
   * `varchar(128)`, `int`, `uuid`. The result is stored as catalog
   * documentation; it is never a real type the admin can "apply" (no-DDL,
   * task §8 risk). Defensive against the various `ColumnType` shapes
   * (string, function, object) TypeORM exposes.
   */
  private describeColumnType(col: {
    type: unknown;
    length?: string;
  }): string | null {
    const rawType = col.type;
    let base: string | null = null;
    if (typeof rawType === 'string') {
      base = rawType;
    } else if (typeof rawType === 'function') {
      base = (rawType as { name?: string }).name?.toLowerCase() ?? null;
    } else if (rawType != null) {
      base = String(rawType);
    }
    if (!base) return null;
    return col.length ? `${base}(${col.length})` : base;
  }

  private tableNotFound(id: string): NotFoundException {
    return new NotFoundException({
      code: 'CATALOG_TABLE_NOT_FOUND',
      message: 'ไม่พบตารางในแค็ตตาล็อกที่ระบุ',
      id,
    });
  }

  private relationNotFound(id: string): NotFoundException {
    return new NotFoundException({
      code: 'CATALOG_RELATION_NOT_FOUND',
      message: 'ไม่พบความสัมพันธ์ที่ระบุ',
      id,
    });
  }

  private toTableDto(row: AiKnowledgeCatalogTable): CatalogTableDto {
    return {
      id: row.id,
      tableName: row.tableName,
      displayNameTh: row.displayNameTh,
      descriptionTh: row.descriptionTh ?? null,
      domainKey: row.domainKey ?? null,
      isSeeded: row.isSeeded,
      displayOrder: row.displayOrder,
    };
  }

  private toColumnDto(row: AiKnowledgeCatalogColumn): CatalogColumnDto {
    return {
      id: row.id,
      columnName: row.columnName,
      dataType: row.dataType ?? null,
      isNullable: row.isNullable,
      descriptionTh: row.descriptionTh ?? null,
      isPii: row.isPii,
      displayOrder: row.displayOrder,
    };
  }

  private toRelationDto(row: AiKnowledgeCatalogRelation): CatalogRelationDto {
    return {
      id: row.id,
      fromTableId: row.fromTableId,
      toTableId: row.toTableId,
      relationType: row.relationType,
      labelTh: row.labelTh ?? null,
      onDeleteNote: row.onDeleteNote ?? null,
      displayOrder: row.displayOrder,
    };
  }
}
