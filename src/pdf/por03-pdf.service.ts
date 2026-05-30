import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { WorkHistoryLookupService } from 'src/work-history/work-history-lookup.service';
import { isAgencyWorkHistory } from 'src/project-groups/util/agency-data.util';

import { PdfService } from './pdf.service';
import {
  createPor03DetailDocDefinition,
  createPor03SectionDividerDocDefinition,
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
  private readonly logger = new Logger(Por03PdfService.name);

  constructor(
    @InjectRepository(EquipmentProjectGroup)
    private readonly equipmentRepo: Repository<EquipmentProjectGroup>,
    @InjectRepository(DevelopmentPlan)
    private readonly developmentPlanRepo: Repository<DevelopmentPlan>,
    private readonly workHistoryLookup: WorkHistoryLookupService,
    // `forwardRef` is REQUIRED on BOTH sides of the PdfService ↔
    // Por03PdfService cycle. PdfService injects this service with
    // `forwardRef(() => Por03PdfService)` (BE-02, pdf.service.ts:163);
    // without the symmetric forwardRef here Nest fails to resolve
    // dependency index [3] at boot (UndefinedDependencyException).
    @Inject(forwardRef(() => PdfService))
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
      // rather than render an empty axis. The owner path THROWS here;
      // the shared `buildPor03Buffer` core instead returns null (the
      // plan-wide caller relies on that degradation), so this guard
      // stays in the owner `generate()` path per BE-01 scope.
      throw new BadRequestException({
        code: 'EQUIPMENT_PRINT_PLAN_WINDOW_MISSING',
        message: 'แผนพัฒนาต้นทางไม่มี startYear/endYear กรุณาตรวจสอบ',
      });
    }

    // Shared render tail (extracted to `buildPor03Buffer`). For the
    // owner path the rows have already been ownership/shape/mixed-plan
    // validated and the plan window asserted non-null above, so the
    // core never returns null here in practice. The defensive
    // empty-selection guard below preserves the prior contract.
    const pdfBuffer = await this.buildPor03Buffer(rows, parentPlan);

    if (!pdfBuffer) {
      // groups.length === 0 — every other branch above has thrown by
      // now (zero ids would have produced a 404), so this is a
      // defensive guard rather than a reachable path.
      throw new BadRequestException({
        code: 'EQUIPMENT_PRINT_EMPTY_SELECTION',
        message: 'ไม่มีครุภัณฑ์สำหรับพิมพ์',
      });
    }

    // Q6 — arm the cooldown ONLY after a successful 2xx render. Any
    // throw above skips this line, satisfying the "5xx does NOT arm"
    // contract automatically (5xx propagates from this method as a
    // thrown exception, never reaching this line).
    this.armCooldown(callerWhId);

    return pdfBuffer;
  }

  // ──────────────────────────────────────────────────────────────────
  // Shared render core (BE-01, wave-staff-draftbook-por03-append)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Shared ผ.03 render tail — the pdfmake layout pipeline that BOTH the
   * owner-side `generate()` AND the staff plan-wide
   * `renderPlanScopedPor03Buffer()` reuse. Extracted verbatim from the
   * former `generate()` render tail so there is no layout/grouping
   * duplication (WAVE.md Q3).
   *
   * Pipeline: year-axis derivation (from `parentPlan` window) →
   * `groupRows` → cover-line resolution → `createPor03DetailDocDefinition`
   * → `createPdfBuffer`.
   *
   * Degradation (read-only, never throws on equipment edge cases):
   *   - Returns `null` if the parent plan window
   *     (`startYear`/`endYear`) is missing — the owner `generate()`
   *     throws `EQUIPMENT_PRINT_PLAN_WINDOW_MISSING` BEFORE calling this
   *     core, so the throw contract is preserved there; the plan-wide
   *     caller relies on this null degradation.
   *   - Returns `null` if `groups.length === 0` (renderer returns null).
   *
   * Writes NOTHING — no audit, no AI snapshot, no TrackingStatus, no
   * cooldown (§17.2). Cooldown arming stays in `generate()`.
   */
  private async buildPor03Buffer(
    rows: EquipmentProjectGroup[],
    parentPlan: DevelopmentPlan,
  ): Promise<Buffer | null> {
    // Degrade (do NOT throw) on a missing plan window. The owner path
    // guards + throws upstream; the plan-wide path wants a clean null.
    if (!parentPlan?.startYear || !parentPlan?.endYear) {
      return null;
    }

    // README §10 — year axis derived from parent plan's [startYear,
    // endYear] window. Coerce to Number defensively: if the
    // DevelopmentPlan start/end columns hydrate as strings, `startYear +
    // i` would string-concat and the per-year budget match would never
    // hit (silent blank budget columns).
    const startYear = Number(parentPlan.startYear);
    const endYear = Number(parentPlan.endYear);
    const years = Array.from(
      { length: endYear - startYear + 1 },
      (_, i) => startYear + i,
    );

    // Grouping (README §8) — Category(sortOrder ASC) → Tactic(id ASC)
    // → Plan(id ASC) → rows(equipmentName ASC).
    const groups = this.groupRows(rows);

    // Render: a SINGLE document. The 4-line centered cover block is
    // embedded as the first item of `content[]` inside the detail doc.
    const fonts = this.pdfService.getPdfFonts();
    const newWord = this.pdfService.newWord.bind(this.pdfService);

    // Resolve the plan-name line for the centered cover block. Per
    // user spec the third cover line is the parent plan's display
    // name, which already encodes the "พ.ศ. {start-end}" window
    // (e.g., "แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570"). If `name` is empty
    // we synthesize the line from the validated start/end window so
    // the output is never blank.
    const developmentPlanLine = parentPlan.name?.trim()
      ? parentPlan.name
      : `แผนพัฒนาท้องถิ่น พ.ศ. ${parentPlan.startYear}-${parentPlan.endYear}`;

    const detailDoc = createPor03DetailDocDefinition({
      developmentPlanName: developmentPlanLine,
      groups,
      years,
      newWord,
    });

    if (!detailDoc) {
      // groups.length === 0 — no renderable rows.
      return null;
    }

    return this.pdfService.createPdfBuffer(detailDoc, fonts);
  }

  /**
   * Plan-WIDE ผ.03 render core for the staff draft-book generator
   * (BE-01, wave-staff-draftbook-por03-append). Renders ALL equipment
   * under `developmentPlanId` whose latest tracking status is in
   * `{ Pending_Approval, Approved }`, regardless of creator (staff sees
   * all). STRATEGY_BASED-only (ISSUE_BASED rows skipped per row).
   *
   * Degrades to `null` (NEVER throws on equipment edge cases — WAVE.md
   * Q2 / risk row) when:
   *   - the plan is missing
   *   - the plan is ISSUE_BASED (Q2 skip)
   *   - the plan window (startYear/endYear) is missing
   *   - there is zero qualifying equipment after the STRATEGY filter
   *
   * Read-only (§17.2): NO ownership check, NO agency-only assertion, NO
   * cooldown, NO audit / AI / TrackingStatus writes. Plan scope binding
   * is via the passed `developmentPlanId` ONLY (§10).
   */
  async renderPlanScopedPor03Buffer(
    developmentPlanId: string,
  ): Promise<Buffer | null> {
    // §10 — bind to the passed plan id; never a global latest lookup.
    const parentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId, deletedAt: IsNull() },
    });

    // Missing plan → no ผ.03 section.
    if (!parentPlan) {
      this.logger.warn(
        `renderPlanScopedPor03Buffer: DevelopmentPlan ${developmentPlanId} not found; skipping ผ.03 section`,
      );
      return null;
    }

    // Q2 — ISSUE_BASED plans skip the ผ.03 section entirely (no throw).
    if (parentPlan.reportFormat === ReportFormat.ISSUE_BASED) {
      this.logger.warn(
        `renderPlanScopedPor03Buffer: plan ${developmentPlanId} is ISSUE_BASED (reportFormat=${parentPlan.reportFormat}); ผ.03 not supported — skipping section`,
      );
      return null;
    }

    // Q2 / risk row — missing plan window degrades to null.
    if (!parentPlan.startYear || !parentPlan.endYear) {
      this.logger.warn(
        `renderPlanScopedPor03Buffer: plan ${developmentPlanId} missing startYear/endYear; skipping ผ.03 section`,
      );
      return null;
    }

    // Plan-wide equipment fetch. Mirrors the EXISTS-subquery latest-
    // status pattern from `EquipmentProjectGroupService.findAll`
    // (`equipment-project-group.service.ts:557-566`) and the status set
    // from `findProjectsForDraftAgency` (`pdf.service.ts:761`). Eager-
    // loads the same relations the owner `generate()` find loads.
    const rows = await this.equipmentRepo
      .createQueryBuilder('equipment')
      .leftJoinAndSelect('equipment.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('equipment.equipmentCategory', 'equipmentCategory')
      .leftJoinAndSelect('equipment.tactic', 'tactic')
      .leftJoinAndSelect('equipment.plan', 'plan')
      .leftJoinAndSelect('equipment.strategy', 'strategy')
      .leftJoinAndSelect('equipment.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('equipment.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('equipment.budgets', 'budgets')
      .leftJoinAndSelect('equipment.createdBy', 'createdBy')
      .where('developmentPlan.id = :planId', { planId: developmentPlanId })
      .andWhere('equipment.deletedAt IS NULL')
      .andWhere(
        'EXISTS (SELECT 1 FROM tracking_status ts ' +
          ' INNER JOIN status s ON s.id = ts.status_id ' +
          ' WHERE ts.equipment_project_group_id = equipment.id ' +
          '   AND ts.is_latest = true ' +
          '   AND s.name IN (:...statusNames))',
        { statusNames: ['Pending_Approval', 'Approved'] },
      )
      .getMany();

    this.logger.log(
      `renderPlanScopedPor03Buffer: plan ${developmentPlanId} (reportFormat=${parentPlan.reportFormat}) — ${rows.length} equipment row(s) matched status IN {Pending_Approval, Approved}`,
    );

    // Q2 — STRATEGY_BASED-only narrowing. Skip (do NOT throw) any row
    // that is not STRATEGY_BASED-shaped. Shape SHOULD follow the parent
    // plan format, so an ISSUE_BASED row under a STRATEGY_BASED plan is
    // a defensive edge case worth logging.
    const filteredRows = rows.filter((r) => {
      const isStrategyShape =
        !!r.strategy && !!r.tactic && !!r.plan && !r.developmentIssue;
      if (!isStrategyShape) {
        this.logger.warn(
          `renderPlanScopedPor03Buffer: equipment ${r.id} under STRATEGY_BASED plan ${developmentPlanId} is not STRATEGY_BASED-shaped; skipping row`,
        );
      }
      return isStrategyShape;
    });

    // Zero qualifying rows → no ผ.03 section.
    if (filteredRows.length === 0) {
      this.logger.warn(
        `renderPlanScopedPor03Buffer: plan ${developmentPlanId} — 0 STRATEGY_BASED-shaped equipment rows after filter (matched=${rows.length}); skipping ผ.03 section. ` +
          `Likely causes: equipment still Verified (not yet "รวมเล่ม ผ.03" → Pending_Approval), or equipment belongs to a different plan.`,
      );
      return null;
    }

    this.logger.log(
      `renderPlanScopedPor03Buffer: plan ${developmentPlanId} — appending ผ.03 section with ${filteredRows.length} equipment row(s)`,
    );

    const detailBuffer = await this.buildPor03Buffer(filteredRows, parentPlan);

    // buildPor03Buffer degrades to null on missing window / zero groups.
    // Those guards already ran above, but keep the null-propagation so a
    // late degradation still yields a clean "no ผ.03 section" result.
    if (!detailBuffer) {
      return null;
    }

    // Prepend the full-page "บัญชีครุภัณฑ์ (ผ.03)" section divider so
    // the combined staff draft book gets a clean visual break between
    // the ผ.02 project section and the appended ผ.03 equipment section,
    // mirroring ผ.02's per-strategy divider pages (user direction
    // 2026-05-30). Owner-side `generate()` is UNTOUCHED — it calls
    // `buildPor03Buffer` directly and keeps its inline cover block.
    const fonts = this.pdfService.getPdfFonts();
    const dividerDoc = createPor03SectionDividerDocDefinition();
    const dividerBuffer = await this.pdfService.createPdfBuffer(
      dividerDoc,
      fonts,
    );

    return this.pdfService.mergePdfBuffers([dividerBuffer, detailBuffer]);
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
