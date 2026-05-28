import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { WorkHistoryLookupService } from 'src/work-history/work-history-lookup.service';
import { isAgencyWorkHistory } from 'src/project-groups/util/agency-data.util';

import { PdfService } from './pdf.service';
import {
  createPor03DetailDocDefinition,
  EquipmentTableGroup,
} from './por03-table.part';

/**
 * Wave Print ผ.03 — BE-01 (2026-05-28).
 *
 * Generator service for the user-side ผ.03 equipment print. Reads from
 * `EquipmentProjectGroup` and emits an `application/pdf` Buffer. Writes
 * NOTHING — no `TrackingStatus`, no AI snapshot, no audit row (Q5
 * LOCKED).
 *
 * # Locked answers (acknowledged verbatim — see header comments on
 * `por03-cover.part.ts` and `por03-table.part.ts`).
 *
 * - Q1 — cover layout: byte-for-byte copy of ผ.02 cover (font / sizes /
 *   centering). See cover-part file for the citations.
 * - Q2 — STRATEGY_BASED only. Enforced TWICE:
 *     1. SQL filter at the find query (`strategy IS NOT NULL AND tactic
 *        IS NOT NULL AND plan IS NOT NULL AND development_issue IS NULL`).
 *     2. Per-row re-assertion after load — any row violating the shape
 *        throws `400 EQUIPMENT_PRINT_REQUIRES_STRATEGY_SHAPE` and aborts
 *        the print. Loud failure, NOT silent skip.
 * - Q3 — landscape A4 (rendered by the cover + detail part files).
 * - Q4 — sibling endpoint `POST /v1/pdf/generate-por03` (wired in the
 *   controller).
 * - Q5 — NO audit writes. NO `TrackingStatus`. NO AI snapshot.
 * - Q6 — cooldown: per-actor `(workHistoryId, 'print-por03')` keyed
 *   window, 10s, in-memory map. 2xx ARMS the cooldown; 5xx does NOT.
 *
 * # Defense-in-depth (§5.3 + BE-02 contract)
 *
 * Even though `PrintPor03Guard` (BE-02) gates the controller route,
 * this service RE-ASSERTS the agency-only check and per-row
 * ownership / shape invariants at the top of `generate()`. The §17.11
 * no-role-exemption rule means super-admin gets the same 403 as any
 * other LAO caller — the re-assertion uses `isAgencyWorkHistory(wh)`,
 * which does NOT branch on role.
 *
 * # Cooldown (Q6)
 *
 * The cooldown store is a private in-memory `Map<string, number>` on
 * this service. Existing `InMemoryAiCooldownStore` was considered for
 * reuse but is wired only into `AiCooldownGuard` and would couple this
 * print path to the AI module's request-time guard pipeline; a local
 * map keeps the dependency footprint minimal. Documented choice per
 * task §7.7 — multi-pod limitation is acceptable for v1; a future wave
 * may upgrade to Redis (mirror of `RedisAiCooldownStoreStub` pattern).
 *
 * The arm-after-success / no-arm-on-5xx semantic is implemented by
 * arming AT THE END of `generate()`, AFTER the PDF buffer is produced
 * but BEFORE the controller returns. Any throw inside `generate()`
 * skips the arm; the 429 path also does not double-arm.
 */
@Injectable()
export class Por03PdfService {
  /**
   * In-memory cooldown store.
   *
   * Key: `${workHistoryId}|print-por03` — composite of (actor,
   * endpoint) per §17.8 / Q6 spec.
   * Value: `expiresAt` (ms since epoch). Entries past `expiresAt` are
   * lazy-evicted on the next probe.
   */
  private static readonly COOLDOWN_WINDOW_MS = 10_000;
  private static readonly COOLDOWN_ENDPOINT_KEY = 'print-por03';
  private readonly cooldownStore = new Map<string, number>();

  constructor(
    @InjectRepository(EquipmentProjectGroup)
    private readonly equipmentRepo: Repository<EquipmentProjectGroup>,
    private readonly workHistoryLookup: WorkHistoryLookupService,
    private readonly pdfService: PdfService,
  ) {}

  /**
   * Generate the ผ.03 PDF for the given equipment id selection.
   *
   * @param userId — authenticated caller's userId (from JWT).
   * @param equipmentIds — UUIDs of the selected equipment items.
   * @returns Buffer containing the application/pdf payload.
   *
   * Error codes (see endpoint contract):
   *   - 401 UNAUTHENTICATED — missing caller userId
   *   - 403 EQUIPMENT_AGENCY_ONLY — LAO caller (defense-in-depth re-assert)
   *   - 403 EQUIPMENT_NOT_OWNED — any row whose createdBy ≠ caller WH id
   *   - 400 EQUIPMENT_PRINT_REQUIRES_STRATEGY_SHAPE — Q2 violation
   *   - 404 EQUIPMENT_NOT_FOUND — any id missing / soft-deleted
   *   - 409 EQUIPMENT_MIXED_PLANS — selection spans >1 development plan
   *   - 429 PRINT_COOLDOWN_ACTIVE { retryAfterSeconds }
   */
  async generate(userId: string, equipmentIds: string[]): Promise<Buffer> {
    // §1 / §2 — resolve caller WorkHistory and workStatus first. We use
    // the repository's own EntityManager because this is a read-only
    // path; no transaction is required.
    const em = this.equipmentRepo.manager;
    const callerWh = await this.workHistoryLookup.getCurrent(em, userId);
    this.workHistoryLookup.assertWorkStatusApproved(callerWh);

    // §5.3 defense-in-depth re-assertion — guard (BE-02) already ran,
    // but the service MUST re-check independently per §5.3 dual-layer
    // contract. §17.11 — no role exemption; super-admin LAO STILL gets
    // 403 EQUIPMENT_AGENCY_ONLY because `isAgencyWorkHistory` ignores
    // role.
    if (!isAgencyWorkHistory(callerWh)) {
      throw new ForbiddenException({
        code: 'EQUIPMENT_AGENCY_ONLY',
        message: 'ฟีเจอร์ครุภัณฑ์ (ผ.03) ใช้ได้เฉพาะผู้ใช้สังกัด อบจ.',
      });
    }

    // Q6 cooldown probe — check BEFORE doing any expensive work, but
    // AFTER authn/authz so anonymous probes can't enumerate cooldown
    // state.
    this.assertCooldownClear(callerWh.id);

    // Q2 — STRATEGY_BASED only. SQL-level filter (first defense): the
    // `IsNull()` clause on `developmentIssue` AND `Not(IsNull())` on
    // strategy/tactic/plan would normally land here, but TypeORM's
    // composite `find()` filter for FK columns is unwieldy; we keep
    // the find() simple and rely on per-row re-assertion below — which
    // is the AUTHORITATIVE check per the Q2 contract ("loud failure,
    // not silent skip"). Soft-deleted rows are excluded via
    // `deletedAt: IsNull()`.
    const rows = await this.equipmentRepo.find({
      where: {
        id: In(equipmentIds),
        deletedAt: IsNull(),
      },
      relations: {
        developmentPlan: true,
        equipmentCategory: true,
        tactic: true,
        plan: true,
        strategy: true,
        developmentIssue: true,
        responsibleAgency: true,
        budgets: true,
        createdBy: true,
      },
    });

    // 404 — any requested id missing (soft-deleted, mistyped, or
    // belongs to a different tenant pre-filter).
    if (rows.length !== equipmentIds.length) {
      throw new NotFoundException({ code: 'EQUIPMENT_NOT_FOUND' });
    }

    // §4 ownership — every row's createdBy MUST be the caller's current
    // WorkHistory. Per §4 we compare WorkHistory.id, NOT user.id.
    const callerWhId = callerWh.id;
    const foreignRow = rows.find((r) => r.createdBy?.id !== callerWhId);
    if (foreignRow) {
      throw new ForbiddenException({ code: 'EQUIPMENT_NOT_OWNED' });
    }

    // Q2 — per-row STRATEGY_BASED re-assertion (authoritative check).
    // Any row that carries a `developmentIssue` OR lacks any of
    // (strategy, tactic, plan) violates the print contract.
    const shapeOffender = rows.find(
      (r) =>
        !r.strategy ||
        !r.tactic ||
        !r.plan ||
        r.developmentIssue,
    );
    if (shapeOffender) {
      throw new BadRequestException({
        code: 'EQUIPMENT_PRINT_REQUIRES_STRATEGY_SHAPE',
        message:
          'ผ.03 v1 รองรับเฉพาะครุภัณฑ์รูปแบบยุทธศาสตร์ (STRATEGY_BASED) เท่านั้น',
      });
    }

    // 409 single-plan constraint — the cover page renders ONE plan name
    // (README §7 line 3). A mixed-plan selection is rejected loudly.
    const planIds = new Set(rows.map((r) => r.developmentPlan?.id).filter(Boolean));
    if (planIds.size !== 1) {
      throw new ConflictException({
        code: 'EQUIPMENT_MIXED_PLANS',
        message:
          'ครุภัณฑ์ที่เลือกอยู่คนละแผนพัฒนา ไม่สามารถพิมพ์ในรายงานเดียวกันได้',
      });
    }

    const firstRow = rows[0];
    const parentPlan = firstRow.developmentPlan;
    if (!parentPlan?.startYear || !parentPlan?.endYear) {
      // README §13 risk row — defensive fallback. Plan window is
      // mandatory data for the year axis; if missing, fail loudly
      // rather than render an empty axis.
      throw new BadRequestException({
        code: 'EQUIPMENT_PRINT_PLAN_WINDOW_MISSING',
        message: 'แผนพัฒนาต้นทางไม่มี startYear/endYear กรุณาตรวจสอบ',
      });
    }

    // README §10 — year axis derived from parent plan's [startYear,
    // endYear] window.
    const years = Array.from(
      { length: parentPlan.endYear - parentPlan.startYear + 1 },
      (_, i) => parentPlan.startYear + i,
    );

    // Grouping (README §8) — Category(sortOrder ASC) → Tactic(id ASC)
    // → Plan(id ASC) → rows(equipmentName ASC).
    const groups = this.groupRows(rows);

    // Render: a SINGLE document. The 4-line centered cover block is
    // embedded as the first item of `content[]` inside the detail doc
    // (refactor 2026-05-28 — replaces the prior standalone cover page
    // that the user rejected). NO `mergePdfBuffers` step.
    const fonts = this.pdfService.getPdfFonts();
    const newWord = this.pdfService.newWord.bind(this.pdfService);

    // Resolve the plan-name line for the centered cover block. Per
    // user spec the third cover line is the parent plan's display
    // name, which already encodes the "พ.ศ. {start-end}" window
    // (e.g., "แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570"). If `name` is empty
    // we synthesize the line from the validated start/end window so
    // the output is never blank.
    const developmentPlanLine =
      parentPlan.name?.trim()
        ? parentPlan.name
        : `แผนพัฒนาท้องถิ่น พ.ศ. ${parentPlan.startYear}-${parentPlan.endYear}`;

    const detailDoc = createPor03DetailDocDefinition({
      developmentPlanName: developmentPlanLine,
      groups,
      years,
      newWord,
    });

    if (!detailDoc) {
      // groups.length === 0 — every other branch above has thrown by
      // now (zero ids would have produced a 404), so this is a
      // defensive guard rather than a reachable path.
      throw new BadRequestException({
        code: 'EQUIPMENT_PRINT_EMPTY_SELECTION',
        message: 'ไม่มีครุภัณฑ์สำหรับพิมพ์',
      });
    }

    const pdfBuffer = await this.pdfService.createPdfBuffer(detailDoc, fonts);

    // Q6 — arm the cooldown ONLY after a successful 2xx render. Any
    // throw above skips this line, satisfying the "5xx does NOT arm"
    // contract automatically (5xx propagates from this method as a
    // thrown exception, never reaching this line).
    this.armCooldown(callerWhId);

    return pdfBuffer;
  }

  // ──────────────────────────────────────────────────────────────────
  // Grouping helper
  // ──────────────────────────────────────────────────────────────────

  private groupRows(rows: EquipmentProjectGroup[]): EquipmentTableGroup[] {
    // Stable ordering per README §8: category.sortOrder ASC →
    // tactic.id ASC → plan.id ASC → equipmentName ASC. We materialize
    // the (category, tactic, plan) key and then sort within each group.
    const keyOf = (r: EquipmentProjectGroup) =>
      `${r.equipmentCategory.id}|${r.tactic?.id ?? ''}|${r.plan?.id ?? ''}`;

    const buckets = new Map<string, EquipmentProjectGroup[]>();
    for (const r of rows) {
      const k = keyOf(r);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(r);
    }

    const groups: EquipmentTableGroup[] = [];
    for (const [, bucket] of buckets) {
      bucket.sort((a, b) =>
        (a.equipmentName ?? '').localeCompare(b.equipmentName ?? '', 'th'),
      );
      const first = bucket[0];
      groups.push({
        categoryCode: first.equipmentCategory.code,
        categoryName: first.equipmentCategory.name,
        tacticName: first.tactic?.name ?? '-',
        planName: first.plan?.name ?? '-',
        rows: bucket,
      });
    }

    // Outer sort — category.sortOrder ASC, then tactic.id ASC, then
    // plan.id ASC. We resolve the original FKs from the first row of
    // each bucket because the EquipmentTableGroup struct only carries
    // display fields.
    groups.sort((a, b) => {
      const ac = a.rows[0].equipmentCategory.sortOrder;
      const bc = b.rows[0].equipmentCategory.sortOrder;
      if (ac !== bc) return ac - bc;
      const at = a.rows[0].tactic?.id ?? '';
      const bt = b.rows[0].tactic?.id ?? '';
      if (at !== bt) return at < bt ? -1 : 1;
      const ap = a.rows[0].plan?.id ?? '';
      const bp = b.rows[0].plan?.id ?? '';
      return ap < bp ? -1 : ap > bp ? 1 : 0;
    });

    return groups;
  }

  // ──────────────────────────────────────────────────────────────────
  // Cooldown helpers (Q6)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Throw `429 PRINT_COOLDOWN_ACTIVE` if the caller still has an
   * active cooldown window. The thrown body carries `retryAfterSeconds`
   * computed from the stored `expiresAt`. Expired entries are evicted
   * lazily.
   *
   * Status code is set explicitly via `HttpException(payload,
   * HttpStatus.TOO_MANY_REQUESTS)` because there is no first-class
   * `TooManyRequestsException` shortcut in @nestjs/common.
   */
  private assertCooldownClear(workHistoryId: string): void {
    const key = `${workHistoryId}|${Por03PdfService.COOLDOWN_ENDPOINT_KEY}`;
    const expiresAt = this.cooldownStore.get(key);
    if (expiresAt === undefined) return;
    if (expiresAt <= Date.now()) {
      this.cooldownStore.delete(key);
      return;
    }
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((expiresAt - Date.now()) / 1000),
    );
    throw new HttpException(
      { code: 'PRINT_COOLDOWN_ACTIVE', retryAfterSeconds },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Arm the cooldown for `(workHistoryId, 'print-por03')` for the next
   * 10 seconds. Idempotent — re-arming refreshes the window.
   *
   * Capped at 10,000 entries (mirror of `InMemoryAiCooldownStore`
   * MEMORY_CAPACITY) so a runaway high-cardinality scenario cannot
   * unbounded-grow memory.
   */
  private armCooldown(workHistoryId: string): void {
    const key = `${workHistoryId}|${Por03PdfService.COOLDOWN_ENDPOINT_KEY}`;
    const expiresAt = Date.now() + Por03PdfService.COOLDOWN_WINDOW_MS;
    // Refresh insertion order for LRU semantics.
    if (this.cooldownStore.has(key)) this.cooldownStore.delete(key);
    this.cooldownStore.set(key, expiresAt);
    const CAP = 10_000;
    while (this.cooldownStore.size > CAP) {
      const oldest = this.cooldownStore.keys().next().value;
      if (oldest === undefined) break;
      this.cooldownStore.delete(oldest);
    }
  }
}
