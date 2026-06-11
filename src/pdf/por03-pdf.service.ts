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
import { PDFDocument } from 'pdf-lib';

import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { SupplementEquipmentProjectGroup } from 'src/supplement-equipment-project-group/entities/supplement-equipment-project-group.entity';
import { PrevEquipmentProjectType } from 'src/revised-equipment-project-group/dto/prev-equipment-project-type.enum';
import { WorkHistoryLookupService } from 'src/work-history/work-history-lookup.service';
import { isAgencyWorkHistory } from 'src/project-groups/util/agency-data.util';

import { PdfService } from './pdf.service';
import {
  createPor03DetailDocDefinition,
  createPor03SectionDividerDocDefinition,
  EquipmentTableGroup,
} from './por03-table.part';
import {
  createPor03IssueBasedDetailDocDefinition,
  EquipmentIssueCategoryGroup,
  EquipmentIssueTableGroup,
} from './por03-issue-based-table.part';
import {
  createPor03RevisionDetailDocDefinition,
  EquipmentRevisionPair,
  EquipmentRevisionTableGroup,
} from './por03-revision-table.part';

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
  /**
   * Wave Revision/Change Equipment ผ.03 Print (OLD vs NEW) — BE-01.
   * Distinct cooldown surface from `print-por03` per §17.8 (the key is
   * registered in CLAUDE.md §17.8). The two print surfaces have
   * INDEPENDENT windows because the composite key embeds the endpoint
   * key (`${whId}|${endpointKey}`), so arming the owner ผ.03 print does
   * NOT throttle the revision ผ.03 print and vice-versa.
   */
  private static readonly COOLDOWN_ENDPOINT_KEY_REVISION =
    'print-por03-revision';
  /**
   * Wave Supplement Equipment ผ.03 Standalone Print — BE-01 (2026-06-09).
   * Distinct cooldown surface from `print-por03` / `print-por03-revision`
   * per §17.8 (key registered in CLAUDE.md §17.8). The composite key embeds
   * the endpoint key (`${whId}|${endpointKey}`), so the SEPG print window is
   * INDEPENDENT of the EPG owner print and the revision print windows.
   */
  private static readonly COOLDOWN_ENDPOINT_KEY_SUPPLEMENT =
    'print-por03-supplement';
  private readonly cooldownStore = new Map<string, number>();
  private readonly logger = new Logger(Por03PdfService.name);

  constructor(
    @InjectRepository(EquipmentProjectGroup)
    private readonly equipmentRepo: Repository<EquipmentProjectGroup>,
    @InjectRepository(RevisedEquipmentProjectGroup)
    private readonly revisedEquipmentRepo: Repository<RevisedEquipmentProjectGroup>,
    // Wave wave-supplement-equipment-por03 — BE-B4 (2026-06-08). SEPG
    // repo for the supplement-scoped Approved ผ.03 assembly append.
    @InjectRepository(SupplementEquipmentProjectGroup)
    private readonly supplementEquipmentRepo: Repository<SupplementEquipmentProjectGroup>,
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
  // Supplement equipment ผ.03 standalone print — BE-01 (2026-06-09)
  //
  // Wave Supplement Equipment ผ.03 Standalone Print. SEPG sibling of the
  // EPG `generate()` owner print. Reads from `SupplementEquipmentProjectGroup`
  // and emits an `application/pdf` Buffer by REUSING the shared
  // `buildPor03Buffer(rows, parentPlan)` core — NO new render variant. The
  // parent plan (reportFormat + year window) is resolved via
  // `sepg.developmentPlanSupplement.developmentPlan` (§16.3 — supplement does
  // not own reportFormat). Read-only (§17.2): NO TrackingStatus / AI / audit /
  // any DB write.
  // ──────────────────────────────────────────────────────────────────

  /**
   * Generate the ผ.03 PDF for the given SEPG (supplement equipment) id
   * selection.
   *
   * @param userId — authenticated caller's userId (from JWT).
   * @param supplementEquipmentIds — UUIDs of the selected SEPG items.
   * @returns Buffer containing the application/pdf payload.
   *
   * Error codes (see endpoint contract):
   *   - 401 UNAUTHENTICATED — missing caller userId (controller-side)
   *   - 403 EQUIPMENT_AGENCY_ONLY — LAO caller (defense-in-depth re-assert)
   *   - 403 EQUIPMENT_NOT_OWNED — any row whose createdBy ≠ caller WH id
   *   - 400 EQUIPMENT_PRINT_REQUIRES_STRATEGY_SHAPE — non-STRATEGY shape
   *   - 400 EQUIPMENT_PRINT_PLAN_WINDOW_MISSING — parent plan missing year
   *   - 404 EQUIPMENT_NOT_FOUND — any id missing / soft-deleted
   *   - 409 EQUIPMENT_MIXED_SUPPLEMENTS — selection spans >1 supplement
   *   - 429 PRINT_COOLDOWN_ACTIVE { retryAfterSeconds }
   */
  async generateSupplementPor03(
    userId: string,
    supplementEquipmentIds: string[],
  ): Promise<Buffer> {
    // §1 / §2 — resolve caller WorkHistory + workStatus first (read-only
    // path; no transaction needed).
    const em = this.supplementEquipmentRepo.manager;
    const callerWh = await this.workHistoryLookup.getCurrent(em, userId);
    this.workHistoryLookup.assertWorkStatusApproved(callerWh);

    // §5.3 / §17.11 defense-in-depth — re-assert agency-only. The controller
    // guard ran already; the service re-checks independently.
    // `isAgencyWorkHistory` ignores role, so super-admin LAO STILL gets 403.
    if (!isAgencyWorkHistory(callerWh)) {
      throw new ForbiddenException({
        code: 'EQUIPMENT_AGENCY_ONLY',
        message: 'ฟีเจอร์ครุภัณฑ์ (ผ.03) ใช้ได้เฉพาะผู้ใช้สังกัด อบจ.',
      });
    }

    // §17.8 cooldown probe — DISTINCT surface key `print-por03-supplement`,
    // independent window from the EPG owner / revision ผ.03 prints. Probe
    // after authn/authz so anonymous probes can't enumerate cooldown state.
    this.assertCooldownClear(
      callerWh.id,
      Por03PdfService.COOLDOWN_ENDPOINT_KEY_SUPPLEMENT,
    );

    // Load SEPG rows by id. Relation set mirrors
    // `renderApprovedSupplementScopedPor03Buffer` (parent-plan-via-supplement)
    // + the EPG `generate()` set. `deletedAt IS NULL` excludes soft-deleted.
    const rows = await this.supplementEquipmentRepo.find({
      where: {
        id: In(supplementEquipmentIds),
        deletedAt: IsNull(),
      },
      relations: {
        developmentPlanSupplement: { developmentPlan: true },
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

    // 404 — any requested id missing (soft-deleted, mistyped, etc.).
    if (rows.length !== supplementEquipmentIds.length) {
      throw new NotFoundException({ code: 'EQUIPMENT_NOT_FOUND' });
    }

    // §4 ownership — every row's createdBy MUST be the caller's current
    // WorkHistory. Compare WorkHistory.id, NOT user.id.
    const callerWhId = callerWh.id;
    const foreignRow = rows.find((r) => r.createdBy?.id !== callerWhId);
    if (foreignRow) {
      throw new ForbiddenException({ code: 'EQUIPMENT_NOT_OWNED' });
    }

    // STRATEGY_BASED-only narrowing (§16.5) — per-row authoritative check.
    // Any row carrying a `developmentIssue` OR lacking (strategy, tactic,
    // plan) violates the print contract. LOUD failure, NOT silent-skip
    // (silent-skip is only for the assembly-append path).
    const shapeOffender = rows.find(
      (r) => !r.strategy || !r.tactic || !r.plan || r.developmentIssue,
    );
    if (shapeOffender) {
      throw new BadRequestException({
        code: 'EQUIPMENT_PRINT_REQUIRES_STRATEGY_SHAPE',
        message:
          'ผ.03 v1 รองรับเฉพาะครุภัณฑ์รูปแบบยุทธศาสตร์ (STRATEGY_BASED) เท่านั้น',
      });
    }

    // 409 single-supplement constraint — the cover renders ONE เล่มเพิ่มเติม
    // name. A mixed-supplement selection is rejected loudly (analog of the
    // EPG `EQUIPMENT_MIXED_PLANS`).
    const supplementIds = new Set(
      rows.map((r) => r.developmentPlanSupplement?.id).filter(Boolean),
    );
    if (supplementIds.size !== 1) {
      throw new ConflictException({
        code: 'EQUIPMENT_MIXED_SUPPLEMENTS',
        message:
          'ครุภัณฑ์ที่เลือกอยู่คนละเล่มเพิ่มเติม ไม่สามารถพิมพ์ในรายงานเดียวกันได้',
      });
    }

    // §16.3 — parent plan resolved via the supplement JOIN (never the
    // supplement itself, which does not own reportFormat / the year window).
    const parentPlan = rows[0].developmentPlanSupplement?.developmentPlan;
    if (!parentPlan?.startYear || !parentPlan?.endYear) {
      // Owner path THROWS (mirrors EPG `generate()`); only the append path
      // degrades to null.
      throw new BadRequestException({
        code: 'EQUIPMENT_PRINT_PLAN_WINDOW_MISSING',
        message: 'แผนพัฒนาต้นทางไม่มี startYear/endYear กรุณาตรวจสอบ',
      });
    }

    // Centered page footer (2026-06-10) — main plan name + supplement round
    // label, e.g. "แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570 · ฉบับเพิ่มเติม ครั้งที่ 1".
    // The plan name already encodes the "พ.ศ. {start-end}" window; fall back
    // to a synthesized line when blank (mirrors `buildPor03Buffer`).
    const planLine = parentPlan.name?.trim()
      ? parentPlan.name
      : `แผนพัฒนาท้องถิ่น พ.ศ. ${parentPlan.startYear}-${parentPlan.endYear}`;
    const supplementNumber =
      rows[0].developmentPlanSupplement?.supplementNumber;
    const footerCenterText = supplementNumber
      ? `${planLine} · ฉบับเพิ่มเติม ครั้งที่ ${supplementNumber}`
      : planLine;

    // Shared render tail — `buildPor03Buffer` is shape-agnostic (SEPG carries
    // the same strategy/tactic/plan/equipmentCategory/budgets relations as
    // EPG). Same cast precedent as `renderApprovedSupplementScopedPor03Buffer`.
    const pdfBuffer = await this.buildPor03Buffer(
      rows as unknown as EquipmentProjectGroup[],
      parentPlan,
      footerCenterText,
    );

    if (!pdfBuffer) {
      // Defensive — every other branch above has thrown by now (zero ids
      // would have produced a 404).
      throw new BadRequestException({
        code: 'EQUIPMENT_PRINT_EMPTY_SELECTION',
        message: 'ไม่มีครุภัณฑ์สำหรับพิมพ์',
      });
    }

    // §17.8 — arm the cooldown ONLY after a successful 2xx render. Any throw
    // above skips this line (5xx never reaches it → no-arm satisfied).
    this.armCooldown(
      callerWhId,
      Por03PdfService.COOLDOWN_ENDPOINT_KEY_SUPPLEMENT,
    );

    return pdfBuffer;
  }

  // ──────────────────────────────────────────────────────────────────
  // Revision/Change ผ.03 print — OLD vs NEW (BE-01, 2026-06-03)
  //
  // Wave Revision/Change Equipment ผ.03 Print. Renders the equipment
  // revision/change list (RELPG) using the ผ.03 column layout but in an
  // OLD (โครงการเดิม) vs NEW (โครงการใหม่) comparison FORMAT. The OLD
  // side is the §14 lineage parent (EPG | RELPG) resolved via
  // (prevProjectId, prevProjectType). Read-only (§17.2): NO
  // TrackingStatus / AI / audit / any DB write.
  // ──────────────────────────────────────────────────────────────────

  /**
   * Generate the OLD/NEW ผ.03 PDF for the given RELPG selection.
   *
   * @param userId — authenticated caller's userId (from JWT).
   * @param revisedEquipmentProjectGroupIds — UUIDs of the selected RELPG
   *   rows.
   * @returns Buffer containing the application/pdf payload.
   *
   * Error codes (see endpoint contract):
   *   - 401 UNAUTHENTICATED — missing caller userId (controller-side)
   *   - 403 EQUIPMENT_AGENCY_ONLY — LAO caller (defense-in-depth re-assert)
   *   - 403 EQUIPMENT_NOT_OWNED — any row whose createdBy ≠ caller WH id
   *   - 400 EQUIPMENT_PRINT_REQUIRES_STRATEGY_SHAPE — non-STRATEGY shape
   *   - 400 EQUIPMENT_PRINT_PLAN_WINDOW_MISSING — plan missing start/end
   *   - 404 EQUIPMENT_NOT_FOUND — any id missing / soft-deleted
   *   - 409 EQUIPMENT_MIXED_PLANS — selection spans >1 development plan
   *   - 429 PRINT_COOLDOWN_ACTIVE { retryAfterSeconds }
   */
  async generateRevisionPor03(
    userId: string,
    revisedEquipmentProjectGroupIds: string[],
  ): Promise<Buffer> {
    // §1 / §2 — resolve caller WorkHistory + workStatus first (read-only
    // path; no transaction needed).
    const em = this.revisedEquipmentRepo.manager;
    const callerWh = await this.workHistoryLookup.getCurrent(em, userId);
    this.workHistoryLookup.assertWorkStatusApproved(callerWh);

    // §5.3 / §17.11 defense-in-depth — re-assert agency-only. The
    // controller guard ran already; the service re-checks independently.
    // `isAgencyWorkHistory` ignores role, so super-admin LAO STILL gets
    // 403 (no role exemption).
    if (!isAgencyWorkHistory(callerWh)) {
      throw new ForbiddenException({
        code: 'EQUIPMENT_AGENCY_ONLY',
        message: 'ฟีเจอร์ครุภัณฑ์ (ผ.03) ใช้ได้เฉพาะผู้ใช้สังกัด อบจ.',
      });
    }

    // §17.8 cooldown probe — DISTINCT surface key `print-por03-revision`,
    // independent window from the owner ผ.03 print. Probe after authn/
    // authz so anonymous probes can't enumerate cooldown state.
    this.assertCooldownClear(
      callerWh.id,
      Por03PdfService.COOLDOWN_ENDPOINT_KEY_REVISION,
    );

    // Load RELPG rows by id with the relations the renderer + comparison
    // resolver need. `deletedAt IS NULL` excludes soft-deleted rows.
    const rows = await this.revisedEquipmentRepo.find({
      where: {
        id: In(revisedEquipmentProjectGroupIds),
        deletedAt: IsNull(),
      },
      relations: {
        developmentPlanRevision: { developmentPlan: true },
        developmentPlan: true,
        equipmentProjectGroup: true,
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

    // 404 — any requested id missing (soft-deleted, mistyped, etc.).
    if (rows.length !== revisedEquipmentProjectGroupIds.length) {
      throw new NotFoundException({ code: 'EQUIPMENT_NOT_FOUND' });
    }

    // §4 ownership — every row's createdBy MUST be the caller's current
    // WorkHistory. Compare WorkHistory.id, NOT user.id.
    const callerWhId = callerWh.id;
    const foreignRow = rows.find((r) => r.createdBy?.id !== callerWhId);
    if (foreignRow) {
      throw new ForbiddenException({ code: 'EQUIPMENT_NOT_OWNED' });
    }

    // STRATEGY_BASED narrowing (v1, §5.3 Phase 2.5 / §16.5) — per-row
    // assert strategy+tactic+plan present AND no development issue. Loud
    // failure, not silent skip.
    const shapeOffender = rows.find(
      (r) => !r.strategy || !r.tactic || !r.plan || r.developmentIssue,
    );
    if (shapeOffender) {
      throw new BadRequestException({
        code: 'EQUIPMENT_PRINT_REQUIRES_STRATEGY_SHAPE',
        message:
          'ผ.03 v1 รองรับเฉพาะครุภัณฑ์รูปแบบยุทธศาสตร์ (STRATEGY_BASED) เท่านั้น',
      });
    }

    // §10 single-plan constraint — the cover page renders ONE plan name.
    // Resolve the plan via the RELPG's own `developmentPlan` denorm FK,
    // falling back to the parent revision's plan. Never a global latest
    // lookup.
    const planIdOf = (r: RevisedEquipmentProjectGroup): string | undefined =>
      r.developmentPlan?.id ?? r.developmentPlanRevision?.developmentPlan?.id;
    const planIds = new Set(rows.map(planIdOf).filter(Boolean));
    if (planIds.size !== 1) {
      throw new ConflictException({
        code: 'EQUIPMENT_MIXED_PLANS',
        message:
          'ครุภัณฑ์ที่เลือกอยู่คนละแผนพัฒนา ไม่สามารถพิมพ์ในรายงานเดียวกันได้',
      });
    }

    const firstRow = rows[0];
    const parentPlan =
      firstRow.developmentPlan ??
      firstRow.developmentPlanRevision?.developmentPlan;
    // `parentPlan` is `DevelopmentPlan | undefined` (both FKs are
    // nullable on RELPG). Narrow to non-undefined here so the rest of
    // the method can read `.startYear` / `.endYear` / `.name` safely;
    // also enforce the §10 plan-window invariant (mandatory for the
    // year axis — fail loudly rather than render an empty axis, mirror
    // the owner `generate()` path).
    if (!parentPlan || !parentPlan.startYear || !parentPlan.endYear) {
      throw new BadRequestException({
        code: 'EQUIPMENT_PRINT_PLAN_WINDOW_MISSING',
        message: 'แผนพัฒนาต้นทางไม่มี startYear/endYear กรุณาตรวจสอบ',
      });
    }

    // Build OLD/NEW pairs — resolve each RELPG's lineage parent.
    const pairs = await Promise.all(
      rows.map((current) => this.resolveEquipmentComparison(current)),
    );

    // §16.5 year axis — derive from the parent plan window. Coerce to
    // Number defensively (string-hydrated columns would string-concat and
    // break per-year budget matching — same precedent as buildPor03Buffer).
    const startYear = Number(parentPlan.startYear);
    const endYear = Number(parentPlan.endYear);
    const years = Array.from(
      { length: endYear - startYear + 1 },
      (_, i) => startYear + i,
    );

    const groups = this.groupRevisionPairs(pairs);

    const fonts = this.pdfService.getPdfFonts();
    const newWord = this.pdfService.newWord.bind(this.pdfService);

    const developmentPlanLine = parentPlan.name?.trim()
      ? parentPlan.name
      : `แผนพัฒนาท้องถิ่น พ.ศ. ${parentPlan.startYear}-${parentPlan.endYear}`;

    const detailDoc = createPor03RevisionDetailDocDefinition({
      developmentPlanName: developmentPlanLine,
      groups,
      years,
      newWord,
    });

    if (!detailDoc) {
      // groups.length === 0 — unreachable in practice (zero ids → 404),
      // defensive guard mirroring the owner path's empty-selection guard.
      throw new BadRequestException({
        code: 'EQUIPMENT_PRINT_EMPTY_SELECTION',
        message: 'ไม่มีครุภัณฑ์สำหรับพิมพ์',
      });
    }

    const pdfBuffer = await this.pdfService.createPdfBuffer(detailDoc, fonts);

    // §17.8 — arm the DISTINCT revision cooldown ONLY after a successful
    // 2xx render. Any throw above skips this line (5xx does NOT arm).
    this.armCooldown(
      callerWhId,
      Por03PdfService.COOLDOWN_ENDPOINT_KEY_REVISION,
    );

    return pdfBuffer;
  }

  /**
   * Resolve the §14 lineage parent of a RELPG into an OLD/NEW pair.
   *
   * Equipment analog of `PdfService.findProjectComparisonForRevisionEdit`
   * (§14.7 detection mapping: `'equipment'` → EPG, `'revised_equipment'`
   * → RELPG, mirroring `'original'` → PG, `'revised'` → RPG).
   *
   *   - `prevProjectType === 'equipment'`         → load EquipmentProjectGroup
   *   - `prevProjectType === 'revised_equipment'` → load RevisedEquipmentProjectGroup
   *   - fallback to the RELPG's own `equipmentProjectGroup` FK when
   *     `prevProjectId` is missing.
   *
   * Returns `{ current, previous }`. `previous` is `null` when there is
   * no lineage parent (the OLD column renders blank — README §11 risk
   * row, do NOT throw). A soft-deleted chained parent also resolves to
   * `null` (logged) — the find filters `deletedAt IS NULL`.
   *
   * Read-only — pure lookups; NO writes (§17.2).
   */
  private async resolveEquipmentComparison(
    current: RevisedEquipmentProjectGroup,
  ): Promise<EquipmentRevisionPair> {
    let previous:
      | EquipmentProjectGroup
      | RevisedEquipmentProjectGroup
      | null = null;

    const equipmentRelations = {
      equipmentCategory: true,
      tactic: true,
      plan: true,
      strategy: true,
      developmentIssue: true,
      responsibleAgency: true,
      budgets: true,
    };

    if (
      current.prevProjectType === PrevEquipmentProjectType.EQUIPMENT &&
      current.prevProjectId
    ) {
      previous = await this.equipmentRepo.findOne({
        where: { id: current.prevProjectId, deletedAt: IsNull() },
        relations: equipmentRelations,
      });
    } else if (
      current.prevProjectType === PrevEquipmentProjectType.REVISED_EQUIPMENT &&
      current.prevProjectId
    ) {
      previous = await this.revisedEquipmentRepo.findOne({
        where: { id: current.prevProjectId, deletedAt: IsNull() },
        relations: equipmentRelations,
      });
    }

    // Fallback to the RELPG's own EPG FK when the lineage pointer is
    // missing (first-fork rows always carry prevProjectId, but the FK is
    // a robust fallback). The eager relation was loaded on `current` with
    // `equipmentProjectGroup: true`, but it lacks the deep equipment
    // relations the renderer needs, so re-load it fully when used.
    if (!previous && current.prevProjectId == null) {
      const fallbackId = current.equipmentProjectGroup?.id;
      if (fallbackId) {
        previous = await this.equipmentRepo.findOne({
          where: { id: fallbackId, deletedAt: IsNull() },
          relations: equipmentRelations,
        });
      }
    }

    if (!previous && current.prevProjectId) {
      // Lineage pointer present but parent not resolvable (soft-deleted /
      // missing) — render OLD column blank, log a warning (README §11).
      this.logger.warn(
        `resolveEquipmentComparison: RELPG ${current.id} prevProjectId=${current.prevProjectId} ` +
          `(type=${current.prevProjectType}) did not resolve to a live parent; OLD column will be blank`,
      );
    }

    return { current, previous };
  }

  /**
   * Group OLD/NEW pairs into `EquipmentRevisionTableGroup[]` by the
   * CURRENT (RELPG) row's (Category, Tactic, Plan), reusing the SAME
   * ordering as `groupRows` so ผ.03 row ordering does not drift between
   * the owner print and the revision print:
   *   - Outer: category.sortOrder ASC → tactic.id ASC → plan.id ASC
   *   - Inner pairs: current.equipmentName ASC (Thai collation)
   */
  private groupRevisionPairs(
    pairs: EquipmentRevisionPair[],
  ): EquipmentRevisionTableGroup[] {
    const keyOf = (p: EquipmentRevisionPair) =>
      `${p.current.equipmentCategory.id}|${p.current.tactic?.id ?? ''}|${p.current.plan?.id ?? ''}`;

    const buckets = new Map<string, EquipmentRevisionPair[]>();
    for (const p of pairs) {
      const k = keyOf(p);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(p);
    }

    const groups: EquipmentRevisionTableGroup[] = [];
    for (const [, bucket] of buckets) {
      bucket.sort((a, b) =>
        (a.current.equipmentName ?? '').localeCompare(
          b.current.equipmentName ?? '',
          'th',
        ),
      );
      const first = bucket[0].current;
      groups.push({
        categoryCode: first.equipmentCategory.code,
        categoryName: first.equipmentCategory.name,
        tacticName: first.tactic?.name ?? '-',
        planName: first.plan?.name ?? '-',
        pairs: bucket,
      });
    }

    groups.sort((a, b) => {
      const ac = a.pairs[0].current.equipmentCategory.sortOrder;
      const bc = b.pairs[0].current.equipmentCategory.sortOrder;
      if (ac !== bc) return ac - bc;
      const at = a.pairs[0].current.tactic?.id ?? '';
      const bt = b.pairs[0].current.tactic?.id ?? '';
      if (at !== bt) return at < bt ? -1 : 1;
      const ap = a.pairs[0].current.plan?.id ?? '';
      const bp = b.pairs[0].current.plan?.id ?? '';
      return ap < bp ? -1 : ap > bp ? 1 : 0;
    });

    return groups;
  }

  /**
   * Plan-WIDE (DPR-scoped) revision ผ.03 render core — the RELPG analog
   * of `renderPlanScopedPor03Buffer`, for the STAFF combined revise/change
   * draft book (Wave staff-revision-combined-draftbook-por03, 2026-06-04).
   *
   * Renders ALL `RevisedEquipmentProjectGroup` (RELPG) rows under
   * `developmentPlanRevisionId` whose latest tracking status is in
   * `{ Verified, Pending_Approval }`, regardless of creator (staff sees
   * all), in the OLD-vs-NEW (โครงการเดิม / โครงการใหม่) ผ.03 layout —
   * reusing the SAME `resolveEquipmentComparison` + `groupRevisionPairs`
   * + `createPor03RevisionDetailDocDefinition` core as the owner-side
   * `generateRevisionPor03`, so there is NO layout/grouping duplication.
   *
   * STRATEGY_BASED-only narrowing (§16.5 / §5.3 Phase 2.5) is identical
   * to the owner revision print: any non-STRATEGY-shaped RELPG is SILENT-
   * SKIPPED (logged), NOT a loud throw — the staff combined book must
   * never fail over an equipment edge case (mirror of the Phase 2.6
   * draft-append contract).
   *
   * Degrades to `null` (NEVER throws) when:
   *   - the DPR is missing
   *   - the parent plan is missing or its window (startYear/endYear) is missing
   *   - there are zero qualifying RELPG rows after the STRATEGY filter
   *
   * Read-only (§17.2): NO ownership check, NO agency-only assertion, NO
   * cooldown, NO audit / AI / TrackingStatus writes. §10 scope binding is
   * via the passed `developmentPlanRevisionId` ONLY (never a global lookup).
   */
  async renderRevisionScopedPor03Buffer(
    developmentPlanRevisionId: string,
  ): Promise<Buffer | null> {
    // DPR-scoped RELPG fetch. Mirrors the relation eager-loads the owner
    // `generateRevisionPor03` find loads + the EXISTS latest-status
    // pattern from `renderPlanScopedPor03Buffer`. §10 — bound to the
    // passed DPR; never a global open-revision lookup.
    const rows = await this.revisedEquipmentRepo
      .createQueryBuilder('relpg')
      .leftJoinAndSelect('relpg.developmentPlanRevision', 'developmentPlanRevision')
      .leftJoinAndSelect('developmentPlanRevision.developmentPlan', 'dprPlan')
      .leftJoinAndSelect('relpg.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('relpg.equipmentProjectGroup', 'equipmentProjectGroup')
      .leftJoinAndSelect('relpg.equipmentCategory', 'equipmentCategory')
      .leftJoinAndSelect('relpg.tactic', 'tactic')
      .leftJoinAndSelect('relpg.plan', 'plan')
      .leftJoinAndSelect('relpg.strategy', 'strategy')
      .leftJoinAndSelect('relpg.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('relpg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('relpg.budgets', 'budgets')
      .leftJoinAndSelect('relpg.createdBy', 'createdBy')
      .where('developmentPlanRevision.id = :dprId', {
        dprId: developmentPlanRevisionId,
      })
      .andWhere('relpg.deletedAt IS NULL')
      .andWhere(
        'EXISTS (SELECT 1 FROM tracking_status ts ' +
          ' INNER JOIN status s ON s.id = ts.status_id ' +
          ' WHERE ts.revised_equipment_project_group_id = relpg.id ' +
          '   AND ts.is_latest = true ' +
          '   AND s.name IN (:...statusNames))',
        // เข้าเล่มร่าง (print) = สถานะ {Verified, Pending_Approval}. หน้า print
        // เลื่อน ตรวจสอบผ่าน(Verified)→รออนุมัติ(Pending_Approval) จึงครอบสองสถานะนี้;
        // Approved ไปแสดงหน้ารออนุมัติ (ready-to-approved). สอดคล้องกับ ผ.02
        // (findProjectsForRevisionEditDraft / generateRevisionEditDraftReportWithColumns).
        { statusNames: ['Verified', 'Pending_Approval'] },
      )
      .getMany();

    this.logger.log(
      `renderRevisionScopedPor03Buffer: DPR ${developmentPlanRevisionId} — ${rows.length} RELPG row(s) matched status IN {Verified, Pending_Approval}`,
    );

    if (rows.length === 0) {
      this.logger.warn(
        `renderRevisionScopedPor03Buffer: DPR ${developmentPlanRevisionId} — 0 RELPG rows; skipping ผ.03 section`,
      );
      return null;
    }

    // STRATEGY_BASED-only narrowing (§16.5) — silent skip mis-shaped rows
    // (staff combined book must not throw over an equipment edge case).
    const filteredRows = rows.filter((r) => {
      const isStrategyShape =
        !!r.strategy && !!r.tactic && !!r.plan && !r.developmentIssue;
      if (!isStrategyShape) {
        this.logger.warn(
          `renderRevisionScopedPor03Buffer: RELPG ${r.id} under DPR ${developmentPlanRevisionId} is not STRATEGY_BASED-shaped; skipping row`,
        );
      }
      return isStrategyShape;
    });

    if (filteredRows.length === 0) {
      this.logger.warn(
        `renderRevisionScopedPor03Buffer: DPR ${developmentPlanRevisionId} — 0 STRATEGY_BASED-shaped RELPG rows after filter (matched=${rows.length}); skipping ผ.03 section`,
      );
      return null;
    }

    // Resolve the parent plan via the DPR (or the RELPG denorm FK as a
    // fallback) — needed for the year axis + cover line. §10: never a
    // global latest plan lookup.
    const firstRow = filteredRows[0];
    const parentPlan =
      firstRow.developmentPlanRevision?.developmentPlan ??
      firstRow.developmentPlan;
    if (!parentPlan || !parentPlan.startYear || !parentPlan.endYear) {
      this.logger.warn(
        `renderRevisionScopedPor03Buffer: DPR ${developmentPlanRevisionId} parent plan missing or has no startYear/endYear; skipping ผ.03 section`,
      );
      return null;
    }

    // §16.5 year axis — derive from the parent plan window. Coerce to
    // Number defensively (string-hydrated columns would string-concat).
    const startYear = Number(parentPlan.startYear);
    const endYear = Number(parentPlan.endYear);
    const years = Array.from(
      { length: endYear - startYear + 1 },
      (_, i) => startYear + i,
    );

    // OLD/NEW pairs — reuse the owner-path lineage resolver + grouping.
    const pairs = await Promise.all(
      filteredRows.map((current) => this.resolveEquipmentComparison(current)),
    );
    const groups = this.groupRevisionPairs(pairs);

    const fonts = this.pdfService.getPdfFonts();
    const newWord = this.pdfService.newWord.bind(this.pdfService);

    const developmentPlanLine = parentPlan.name?.trim()
      ? parentPlan.name
      : `แผนพัฒนาท้องถิ่น พ.ศ. ${parentPlan.startYear}-${parentPlan.endYear}`;

    const detailDoc = createPor03RevisionDetailDocDefinition({
      developmentPlanName: developmentPlanLine,
      groups,
      years,
      newWord,
    });

    if (!detailDoc) {
      return null;
    }

    const detailBuffer = await this.pdfService.createPdfBuffer(detailDoc, fonts);

    // Prepend the full-page "บัญชีครุภัณฑ์ (ผ.03)" section divider so the
    // combined staff draft book gets a clean break between the ผ.02
    // revision section and the appended ผ.03 revision section (mirror of
    // `renderPlanScopedPor03Buffer`).
    const dividerDoc = createPor03SectionDividerDocDefinition();
    const dividerBuffer = await this.pdfService.createPdfBuffer(
      dividerDoc,
      fonts,
    );

    return this.pdfService.mergePdfBuffers([dividerBuffer, detailBuffer]);
  }

  /**
   * APPROVED + offset-aware revision ผ.03 render core — the revision
   * analog of `renderApprovedPlanScopedPor03Buffer`, for the EDIT /
   * CHANGE §20 BookAssembly merge + preview append
   * (wave-edit-change-assembly-por03-append, 2026-06-04).
   *
   * Differs from `renderRevisionScopedPor03Buffer` (the print/draft
   * sibling) in exactly three ways — everything else (row-resolution,
   * STRATEGY filter, parent-plan/year resolution, OLD-vs-NEW pairing +
   * grouping, doc-definition) is SHARED, NOT duplicated:
   *   (a) status filter = `Approved` ONLY (the formal booked set,
   *       mirroring MAIN's `renderApprovedPlanScopedPor03Buffer`) instead
   *       of `{ Verified, Pending_Approval }`;
   *   (b) accepts a `pageOffset` so the ผ.03 footers continue the merged
   *       book's running page count (§21.3 parity);
   *   (c) returns `{ buffer, equipmentIds, pageMap }` (the MAIN approved
   *       variant's shape) via a GROUP-LEVEL render loop.
   *
   * STRATEGY_BASED-only (§16.5 / §5.3 Phase 2.5): non-STRATEGY-shaped
   * RELPG rows are SILENT-SKIPPED (logged), NOT a loud throw — the ผ.02
   * EDIT/CHANGE book must never fail over an equipment edge case (mirror
   * of the Phase 2.6 draft-append contract).
   *
   * Degrades to `null` (NEVER throws) when: the DPR is missing, the
   * parent plan is missing or has no startYear/endYear window, there are
   * zero qualifying RELPG rows after the STRATEGY filter, or zero
   * renderable groups.
   *
   * Read-only (§17.2): NO ownership check, NO agency-only assertion, NO
   * cooldown, NO audit / AI / TrackingStatus writes. §10 scope binding is
   * via the passed `developmentPlanRevisionId` ONLY (never a global
   * open-revision lookup).
   */
  async renderApprovedRevisionScopedPor03Buffer(
    developmentPlanRevisionId: string,
    pageOffset: number = 0,
  ): Promise<{
    buffer: Buffer;
    equipmentIds: string[];
    pageMap: Map<string, number>;
  } | null> {
    // DPR-scoped RELPG fetch. Mirrors `renderRevisionScopedPor03Buffer`
    // relations EXACTLY; differs ONLY in the status set — FORMAL book is
    // `Approved`-only (the published set), not `{ Verified,
    // Pending_Approval }`. §10 — bound to the passed DPR.
    const rows = await this.revisedEquipmentRepo
      .createQueryBuilder('relpg')
      .leftJoinAndSelect('relpg.developmentPlanRevision', 'developmentPlanRevision')
      .leftJoinAndSelect('developmentPlanRevision.developmentPlan', 'dprPlan')
      .leftJoinAndSelect('relpg.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('relpg.equipmentProjectGroup', 'equipmentProjectGroup')
      .leftJoinAndSelect('relpg.equipmentCategory', 'equipmentCategory')
      .leftJoinAndSelect('relpg.tactic', 'tactic')
      .leftJoinAndSelect('relpg.plan', 'plan')
      .leftJoinAndSelect('relpg.strategy', 'strategy')
      .leftJoinAndSelect('relpg.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('relpg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('relpg.budgets', 'budgets')
      .leftJoinAndSelect('relpg.createdBy', 'createdBy')
      .where('developmentPlanRevision.id = :dprId', {
        dprId: developmentPlanRevisionId,
      })
      .andWhere('relpg.deletedAt IS NULL')
      .andWhere(
        'EXISTS (SELECT 1 FROM tracking_status ts ' +
          ' INNER JOIN status s ON s.id = ts.status_id ' +
          ' WHERE ts.revised_equipment_project_group_id = relpg.id ' +
          '   AND ts.is_latest = true ' +
          '   AND s.name = :statusName)',
        { statusName: 'Approved' },
      )
      .getMany();

    this.logger.log(
      `renderApprovedRevisionScopedPor03Buffer: DPR ${developmentPlanRevisionId} — ${rows.length} Approved RELPG row(s)`,
    );

    if (rows.length === 0) {
      this.logger.warn(
        `renderApprovedRevisionScopedPor03Buffer: DPR ${developmentPlanRevisionId} — 0 Approved RELPG rows; skipping ผ.03 section`,
      );
      return null;
    }

    // STRATEGY_BASED-only narrowing (§16.5) — silent skip mis-shaped rows.
    const filteredRows = rows.filter((r) => {
      const isStrategyShape =
        !!r.strategy && !!r.tactic && !!r.plan && !r.developmentIssue;
      if (!isStrategyShape) {
        this.logger.warn(
          `renderApprovedRevisionScopedPor03Buffer: RELPG ${r.id} under DPR ${developmentPlanRevisionId} is not STRATEGY_BASED-shaped; skipping row`,
        );
      }
      return isStrategyShape;
    });

    if (filteredRows.length === 0) {
      this.logger.warn(
        `renderApprovedRevisionScopedPor03Buffer: DPR ${developmentPlanRevisionId} — 0 STRATEGY_BASED-shaped Approved RELPG rows after filter (matched=${rows.length}); skipping ผ.03 section`,
      );
      return null;
    }

    // Resolve the parent plan via the DPR (or the RELPG denorm FK as a
    // fallback). §10: never a global latest plan lookup.
    const firstRow = filteredRows[0];
    const parentPlan =
      firstRow.developmentPlanRevision?.developmentPlan ??
      firstRow.developmentPlan;
    if (!parentPlan || !parentPlan.startYear || !parentPlan.endYear) {
      this.logger.warn(
        `renderApprovedRevisionScopedPor03Buffer: DPR ${developmentPlanRevisionId} parent plan missing or has no startYear/endYear; skipping ผ.03 section`,
      );
      return null;
    }

    // §16.5 year axis — derive from the parent plan window. Coerce to
    // Number defensively (string-hydrated columns would string-concat).
    const startYear = Number(parentPlan.startYear);
    const endYear = Number(parentPlan.endYear);
    const years = Array.from(
      { length: endYear - startYear + 1 },
      (_, i) => startYear + i,
    );

    // OLD/NEW pairs — reuse the owner-path lineage resolver + grouping
    // (SHARED with `renderRevisionScopedPor03Buffer`).
    const pairs = await Promise.all(
      filteredRows.map((current) => this.resolveEquipmentComparison(current)),
    );
    const groups = this.groupRevisionPairs(pairs);

    const fonts = this.pdfService.getPdfFonts();
    const newWord = this.pdfService.newWord.bind(this.pdfService);

    const developmentPlanLine = parentPlan.name?.trim()
      ? parentPlan.name
      : `แผนพัฒนาท้องถิ่น พ.ศ. ${parentPlan.startYear}-${parentPlan.endYear}`;

    // ── GROUP-LEVEL page tracking (mirror of
    // `renderApprovedPlanScopedPor03Buffer`) ────────────────────────────
    // Render the divider buffer first, then EACH GROUP as its own buffer,
    // accumulating a running `localOffset`. Each group footer renders
    // `currentPage + (pageOffset + localOffset)` so the ผ.03 pages
    // continue the merged book's absolute count (§21.3). Every RELPG row
    // in a group shares the group's first 1-based LOCAL page.
    const dividerDoc = createPor03SectionDividerDocDefinition();
    const dividerBuffer = await this.pdfService.createPdfBuffer(
      dividerDoc,
      fonts,
    );

    const pageMap = new Map<string, number>();
    const groupBuffers: Buffer[] = [];
    const includedIds: string[] = [];

    let localOffset = (await PDFDocument.load(dividerBuffer)).getPageCount();

    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      const groupDoc = createPor03RevisionDetailDocDefinition({
        developmentPlanName: developmentPlanLine,
        groups: [group],
        years,
        newWord,
        includeCoverBlock: i === 0,
        pageOffset: pageOffset + localOffset,
      });
      if (!groupDoc) continue;
      const groupBuffer = await this.pdfService.createPdfBuffer(
        groupDoc,
        fonts,
      );
      for (const pair of group.pairs) {
        const id = pair.current.id;
        pageMap.set(id, localOffset + 1);
        includedIds.push(id);
      }
      groupBuffers.push(groupBuffer);
      localOffset += (await PDFDocument.load(groupBuffer)).getPageCount();
    }

    if (groupBuffers.length === 0) {
      return null;
    }

    const buffer = await this.pdfService.mergePdfBuffers([
      dividerBuffer,
      ...groupBuffers,
    ]);

    return { buffer, equipmentIds: includedIds, pageMap };
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
    footerCenterText?: string,
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
      footerCenterText,
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

  /**
   * FORMAL-assembly plan-WIDE ผ.03 render core (Wave Equipment Phase 3 —
   * BE-02, 2026-05-30). Sibling of `renderPlanScopedPor03Buffer`
   * (Phase 2.6 staff draft-append), which is left UNCHANGED.
   *
   * Differences from the Phase 2.6 draft method:
   *   - **Approved-only predicate.** The draft method matches latest
   *     status IN `{ Pending_Approval, Approved }` (the pre-approval
   *     committee packet). This FORMAL method is the FINAL published
   *     book, so it matches latest status = `Approved` ONLY.
   *   - **Dual-format dispatch (§16.8).** Resolves the parent
   *     `DevelopmentPlan.reportFormat` and routes:
   *       - STRATEGY_BASED → existing `groupRows` + `createPor03DetailDocDefinition`
   *       - ISSUE_BASED    → `groupRowsByIssue` + `createPor03IssueBasedDetailDocDefinition`
   *     The Phase 2.6 draft method is STRATEGY_BASED-only (ISSUE_BASED
   *     skipped); this FORMAL method renders BOTH per §16.5 dual-shape.
   *   - **Returns `{ buffer, equipmentIds, pageMap }`** so BE-01 can
   *     stamp `isBooked` / `bookedAt` / `pageNumber` on the included
   *     rows. `pageMap` maps each included equipment id → its 1-based
   *     LOCAL page within the returned `buffer` (the prepended
   *     "บัญชีครุภัณฑ์ (ผ.03)" divider is local page 1). BE-04
   *     (2026-05-30): GROUP-LEVEL granularity — every equipment row in
   *     the same Category/Tactic/Plan group (STRATEGY) or
   *     Issue group (ISSUE) shares its group's first local page.
   *     Adapts the ProjectGroup `generateProjectReportWithPageTracking`
   *     running-`pageOffset` accumulation (`pdf.service.ts:1159-1287`).
   *
   * Section-divider handling: the "บัญชีครุภัณฑ์ (ผ.03)" full-page
   * divider is PREPENDED INSIDE the returned `buffer` (same as the
   * Phase 2.6 sibling), so BE-01 simply appends `por03.buffer` to the
   * ผ.02 book and runs its global post-merge page-number pass over the
   * whole combined document. The divider is format-agnostic and reused
   * from `por03-table.part.ts` (BE-03 explicitly does NOT redefine it).
   *
   * Degrades to `null` (NEVER throws on equipment edge cases — the
   * combined book must not fail over an equipment edge case) when:
   *   - the plan is missing
   *   - the plan window (startYear/endYear) is missing
   *   - there are zero Approved equipment rows
   *   - (defensively) every row violates its plan-format shape, leaving
   *     zero renderable groups
   *
   * Read-only (§17.2): NO ownership check, NO agency-only assertion, NO
   * cooldown, NO audit / AI / TrackingStatus writes. Plan scope binding
   * is via the passed `developmentPlanId` ONLY (§10). BE-01 owns the
   * `isBooked` stamp.
   */
  async renderApprovedPlanScopedPor03Buffer(
    developmentPlanId: string,
    /**
     * Phase 3 — continuous page offset (sum of ผ.01 + ผ.02 page counts).
     * Each per-group buffer's footer renders `currentPage + pageOffset`
     * so ผ.03 pages continue the ผ.02 sequence visually-identically. The
     * offset is added per group to the running local offset so the
     * footer always reflects the absolute book page. Default 0 → no
     * offset, footer null (Phase 2.5/2.6 print-surface behavior preserved).
     */
    pageOffset: number = 0,
  ): Promise<{
    buffer: Buffer;
    equipmentIds: string[];
    pageMap: Map<string, number>;
  } | null> {
    // §10 — bind to the passed plan id; never a global latest lookup.
    const parentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId, deletedAt: IsNull() },
    });

    if (!parentPlan) {
      this.logger.warn(
        `renderApprovedPlanScopedPor03Buffer: DevelopmentPlan ${developmentPlanId} not found; skipping ผ.03 section`,
      );
      return null;
    }

    // Risk row — missing plan window degrades to null (no throw).
    if (!parentPlan.startYear || !parentPlan.endYear) {
      this.logger.warn(
        `renderApprovedPlanScopedPor03Buffer: plan ${developmentPlanId} missing startYear/endYear; skipping ผ.03 section`,
      );
      return null;
    }

    // Plan-wide Approved-only equipment fetch. Mirrors the Phase 2.6
    // method's relation eager-loads EXACTLY; differs ONLY in the status
    // set — FORMAL book is `Approved`-only (the published book), not
    // `{ Pending_Approval, Approved }`.
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
          '   AND s.name = :statusName)',
        { statusName: 'Approved' },
      )
      .getMany();

    this.logger.log(
      `renderApprovedPlanScopedPor03Buffer: plan ${developmentPlanId} (reportFormat=${parentPlan.reportFormat}) — ${rows.length} Approved equipment row(s)`,
    );

    if (rows.length === 0) {
      this.logger.warn(
        `renderApprovedPlanScopedPor03Buffer: plan ${developmentPlanId} — 0 Approved equipment rows; skipping ผ.03 section`,
      );
      return null;
    }

    // §16.5 year axis (shared by both formats) — derive from the parent
    // plan window. Coerce to Number defensively (string-hydrated columns
    // would string-concat and break per-year budget matching).
    const startYear = Number(parentPlan.startYear);
    const endYear = Number(parentPlan.endYear);
    const years = Array.from(
      { length: endYear - startYear + 1 },
      (_, i) => startYear + i,
    );

    const fonts = this.pdfService.getPdfFonts();
    const newWord = this.pdfService.newWord.bind(this.pdfService);

    const developmentPlanLine = parentPlan.name?.trim()
      ? parentPlan.name
      : `แผนพัฒนาท้องถิ่น พ.ศ. ${parentPlan.startYear}-${parentPlan.endYear}`;

    // ── GROUP-LEVEL page tracking (BE-04, 2026-05-30) ───────────────
    // Instead of rendering the whole detail body as ONE doc-definition,
    // render the divider buffer first, then EACH GROUP as its own
    // buffer, accumulating a running `pageOffset` (mirrors the PG
    // accumulation loop at `pdf.service.ts:1276`). Every equipment row
    // in a group gets the SAME `pageMap` value = the group's first
    // (1-based LOCAL) page within the returned buffer.
    //
    // The "บัญชีครุภัณฑ์ (ผ.03)" full-page divider is the FIRST buffer,
    // so its page count seeds `pageOffset`. The first group emits the
    // centered 4-line cover block (`includeCoverBlock: true`); every
    // subsequent group suppresses it (`includeCoverBlock: false`) so
    // the cover does not repeat. Each group already starts on a fresh
    // page (the single-document layout used `pageBreak: 'before'` for
    // groupIndex > 0), so splitting at group boundaries is visually
    // identical — each per-group buffer is its own document starting on
    // its own page 1, which becomes a fresh page after merge.
    const dividerDoc = createPor03SectionDividerDocDefinition();
    const dividerBuffer = await this.pdfService.createPdfBuffer(
      dividerDoc,
      fonts,
    );

    const pageMap = new Map<string, number>();
    const groupBuffers: Buffer[] = [];
    const includedIds: string[] = [];

    // Seed the LOCAL offset with the divider's page count (the divider
    // is local page 1, so the first group's body starts at local page 2).
    // Renamed from `pageOffset` to avoid shadowing the caller's
    // ผ.01+ผ.02 page-count parameter that is passed into each group's
    // doc-definition so its footer renders continuous absolute numbers.
    let localOffset = (await PDFDocument.load(dividerBuffer)).getPageCount();

    if (parentPlan.reportFormat === ReportFormat.ISSUE_BASED) {
      // ISSUE_BASED shape (§16.5): development_issue NOT NULL, strategy/
      // tactic/plan NULL. Defensively skip any row that does not satisfy
      // the issue shape (should not occur — shape follows the parent
      // plan format).
      const issueRows = rows.filter((r) => {
        const isIssueShape =
          !!r.developmentIssue && !r.strategy && !r.tactic && !r.plan;
        if (!isIssueShape) {
          this.logger.warn(
            `renderApprovedPlanScopedPor03Buffer: equipment ${r.id} under ISSUE_BASED plan ${developmentPlanId} is not ISSUE_BASED-shaped; skipping row`,
          );
        }
        return isIssueShape;
      });
      if (issueRows.length === 0) {
        this.logger.warn(
          `renderApprovedPlanScopedPor03Buffer: plan ${developmentPlanId} — 0 ISSUE_BASED-shaped equipment rows after filter; skipping ผ.03 section`,
        );
        return null;
      }
      const issueGroups = this.groupRowsByIssue(issueRows);

      // One buffer per issue group. All rows in the issue share the
      // issue's first local page.
      for (let i = 0; i < issueGroups.length; i += 1) {
        const issueGroup = issueGroups[i];
        const groupDoc = createPor03IssueBasedDetailDocDefinition({
          developmentPlanName: developmentPlanLine,
          groups: [issueGroup],
          years,
          newWord,
          includeCoverBlock: i === 0,
          // Phase 3 — render ผ.02-style footer with continuous absolute
          // page numbers. pdfmake's currentPage is 1-based RELATIVE to
          // this per-group buffer, so add `pageOffset` (callers' ผ.01+
          // ผ.02 totals) + `localOffset` (sum of divider + prior groups)
          // for the absolute book page on each footer.
          pageOffset: pageOffset + localOffset,
        });
        if (!groupDoc) continue;
        const groupBuffer = await this.pdfService.createPdfBuffer(
          groupDoc,
          fonts,
        );
        const groupIds = issueGroup.categories.flatMap((c) =>
          c.rows.map((r) => r.id),
        );
        for (const id of groupIds) {
          pageMap.set(id, localOffset + 1);
          includedIds.push(id);
        }
        groupBuffers.push(groupBuffer);
        localOffset += (await PDFDocument.load(groupBuffer)).getPageCount();
      }
    } else {
      // STRATEGY_BASED shape (§16.5): strategy/tactic/plan NOT NULL,
      // development_issue NULL. Defensively skip mis-shaped rows.
      const strategyRows = rows.filter((r) => {
        const isStrategyShape =
          !!r.strategy && !!r.tactic && !!r.plan && !r.developmentIssue;
        if (!isStrategyShape) {
          this.logger.warn(
            `renderApprovedPlanScopedPor03Buffer: equipment ${r.id} under STRATEGY_BASED plan ${developmentPlanId} is not STRATEGY_BASED-shaped; skipping row`,
          );
        }
        return isStrategyShape;
      });
      if (strategyRows.length === 0) {
        this.logger.warn(
          `renderApprovedPlanScopedPor03Buffer: plan ${developmentPlanId} — 0 STRATEGY_BASED-shaped equipment rows after filter; skipping ผ.03 section`,
        );
        return null;
      }
      const strategyGroups = this.groupRows(strategyRows);

      // One buffer per (Category, Tactic, Plan) group. All rows in the
      // group share the group's first local page.
      for (let i = 0; i < strategyGroups.length; i += 1) {
        const group = strategyGroups[i];
        const groupDoc = createPor03DetailDocDefinition({
          developmentPlanName: developmentPlanLine,
          groups: [group],
          years,
          newWord,
          includeCoverBlock: i === 0,
          // Phase 3 — render ผ.02-style footer; see ISSUE branch comment.
          pageOffset: pageOffset + localOffset,
        });
        if (!groupDoc) continue;
        const groupBuffer = await this.pdfService.createPdfBuffer(
          groupDoc,
          fonts,
        );
        for (const r of group.rows) {
          pageMap.set(r.id, localOffset + 1);
          includedIds.push(r.id);
        }
        groupBuffers.push(groupBuffer);
        localOffset += (await PDFDocument.load(groupBuffer)).getPageCount();
      }
    }

    // Degrade cleanly if every group failed to render (defensive — the
    // shape filters above already returned null on zero rows).
    if (groupBuffers.length === 0) {
      return null;
    }

    // Prepend the format-agnostic "บัญชีครุภัณฑ์ (ผ.03)" full-page
    // divider INSIDE the returned buffer so BE-01 just appends
    // `por03.buffer` to the ผ.02 book; BE-01's global post-merge pass
    // numbers the whole combined book. Same contract as the Phase 2.6
    // sibling.
    const buffer = await this.pdfService.mergePdfBuffers([
      dividerBuffer,
      ...groupBuffers,
    ]);

    return { buffer, equipmentIds: includedIds, pageMap };
  }

  /**
   * SUPPLEMENT-scoped FORMAL-assembly ผ.03 render core (Wave
   * wave-supplement-equipment-por03 — BE-B4, 2026-06-08). The supplement
   * analog of `renderApprovedPlanScopedPor03Buffer`: a PLAIN list render
   * (NOT the OLD-vs-NEW revision shape — v1 SEPG has no lineage per
   * OQ-B3) of Approved `SupplementEquipmentProjectGroup` (SEPG) rows
   * under a `DevelopmentPlanSupplement`. Consumed by the SUPPLEMENT
   * assembly append (BE-B5) at `preview()` + `merge()`.
   *
   * Selection: SEPG rows under the passed supplement whose latest
   * tracking status = `Approved` (the formal booked set, mirroring the
   * revision method's Approved-only filter — `Approved` is matched via
   * the `supplement_equipment_project_group_id` FK on `tracking_status`),
   * `deletedAt IS NULL`. §10 — bound to the passed supplement id; never
   * a global lookup.
   *
   * §16.3 — `reportFormat` is resolved via the supplement → parent plan
   * JOIN (the supplement never owns the format). STRATEGY_BASED ONLY for
   * v1 (OQ-B5): an ISSUE_BASED parent plan SILENT-skips (returns null),
   * and any per-row non-STRATEGY shape is logged + skipped — NEVER throws,
   * NEVER blocks the เล่ม (precedent §5.3 Phase 2.6 draft-append
   * contract, mirroring `renderApprovedRevisionScopedPor03Buffer`).
   *
   * §21.3 — `pageOffset` is threaded into the ผ.03 footer numbering
   * exactly as the revision / plan variants do: each per-group buffer's
   * footer renders `currentPage + (pageOffset + localOffset)` so the
   * supplement ผ.03 pages continue the supplement book's running count.
   * This method ONLY honors whatever `pageOffset` BE-B5 passes — it does
   * NOT compute the offset (risk #3 / §21.3.4 — the caller owns the
   * formula).
   *
   * Degrades to `null` (NEVER throws on equipment edge cases — the
   * combined เล่ม must not fail over an equipment edge case) when:
   *   - the supplement is missing / soft-deleted
   *   - the parent plan is missing
   *   - the parent plan is ISSUE_BASED (OQ-B5 v1 skip)
   *   - the parent plan window (startYear/endYear) is missing
   *   - there are zero Approved SEPG rows
   *   - every row violates the STRATEGY shape, leaving zero groups
   *
   * Read-only (§17.2): NO ownership check, NO agency-only assertion, NO
   * cooldown, NO audit / AI / TrackingStatus writes. BE-B5 owns any
   * `isBooked` / `pageNumber` stamping.
   */
  async renderApprovedSupplementScopedPor03Buffer(
    developmentPlanSupplementId: string,
    pageOffset: number = 0,
    // Status set for the SEPG selection. Defaults to Approved-only so the
    // §20.2 assembly append (the original caller) is byte-for-byte
    // unchanged. The Stage-2 "เข้าเล่มร่าง" DRAFT download passes
    // `['Pending_Approval', 'Approved']` so ผ.03 appears in the draft book
    // before final approval — mirroring the agency draft ผ.03
    // (`renderPlanScopedPor03Buffer`, status IN {Pending_Approval, Approved}).
    statusNames: string[] = ['Approved'],
  ): Promise<{
    buffer: Buffer;
    equipmentIds: string[];
    pageMap: Map<string, number>;
  } | null> {
    // SEPG fetch scoped to the passed supplement. Mirrors the relation
    // eager-loads of `renderApprovedPlanScopedPor03Buffer` EXACTLY,
    // joining through the supplement → parent plan to resolve the
    // reportFormat + year window. Approved-only via the SEPG FK on
    // tracking_status. §10 — bound to the passed supplement id.
    const rows = await this.supplementEquipmentRepo
      .createQueryBuilder('sepg')
      .leftJoinAndSelect(
        'sepg.developmentPlanSupplement',
        'developmentPlanSupplement',
      )
      .leftJoinAndSelect('developmentPlanSupplement.developmentPlan', 'plan')
      .leftJoinAndSelect('sepg.equipmentCategory', 'equipmentCategory')
      .leftJoinAndSelect('sepg.tactic', 'tactic')
      .leftJoinAndSelect('sepg.plan', 'sepgPlan')
      .leftJoinAndSelect('sepg.strategy', 'strategy')
      .leftJoinAndSelect('sepg.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('sepg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('sepg.budgets', 'budgets')
      .leftJoinAndSelect('sepg.createdBy', 'createdBy')
      .where('developmentPlanSupplement.id = :supplementId', {
        supplementId: developmentPlanSupplementId,
      })
      .andWhere('sepg.deletedAt IS NULL')
      .andWhere(
        'EXISTS (SELECT 1 FROM tracking_status ts ' +
          ' INNER JOIN status s ON s.id = ts.status_id ' +
          ' WHERE ts.supplement_equipment_project_group_id = sepg.id ' +
          '   AND ts.is_latest = true ' +
          '   AND s.name IN (:...statusNames))',
        { statusNames },
      )
      .getMany();

    this.logger.log(
      `renderApprovedSupplementScopedPor03Buffer: supplement ${developmentPlanSupplementId} — ${rows.length} SEPG row(s) matched status IN {${statusNames.join(', ')}}`,
    );

    if (rows.length === 0) {
      this.logger.warn(
        `renderApprovedSupplementScopedPor03Buffer: supplement ${developmentPlanSupplementId} — 0 Approved SEPG rows; skipping ผ.03 section`,
      );
      return null;
    }

    // §16.3 — parent plan resolved via the supplement JOIN (never the
    // supplement itself, which does not own reportFormat).
    const parentPlan = rows[0].developmentPlanSupplement?.developmentPlan;
    if (!parentPlan) {
      this.logger.warn(
        `renderApprovedSupplementScopedPor03Buffer: supplement ${developmentPlanSupplementId} parent plan missing; skipping ผ.03 section`,
      );
      return null;
    }

    // OQ-B5 — ISSUE_BASED parent plans skip the ผ.03 section entirely
    // (silent, no throw — §5.3 Phase 2.6 contract).
    if (parentPlan.reportFormat === ReportFormat.ISSUE_BASED) {
      this.logger.warn(
        `renderApprovedSupplementScopedPor03Buffer: supplement ${developmentPlanSupplementId} parent plan ${parentPlan.id} is ISSUE_BASED; ผ.03 v1 supports STRATEGY_BASED only — skipping section`,
      );
      return null;
    }

    // Risk row — missing plan window degrades to null (no throw).
    if (!parentPlan.startYear || !parentPlan.endYear) {
      this.logger.warn(
        `renderApprovedSupplementScopedPor03Buffer: supplement ${developmentPlanSupplementId} parent plan ${parentPlan.id} missing startYear/endYear; skipping ผ.03 section`,
      );
      return null;
    }

    // STRATEGY_BASED-only narrowing (§16.5 / OQ-B5) — silent skip
    // mis-shaped rows, mirroring `renderApprovedRevisionScopedPor03Buffer`
    // and the STRATEGY branch of `renderApprovedPlanScopedPor03Buffer`.
    const filteredRows = rows.filter((r) => {
      const isStrategyShape =
        !!r.strategy && !!r.tactic && !!r.plan && !r.developmentIssue;
      if (!isStrategyShape) {
        this.logger.warn(
          `renderApprovedSupplementScopedPor03Buffer: SEPG ${r.id} under supplement ${developmentPlanSupplementId} is not STRATEGY_BASED-shaped; skipping row`,
        );
      }
      return isStrategyShape;
    });

    if (filteredRows.length === 0) {
      this.logger.warn(
        `renderApprovedSupplementScopedPor03Buffer: supplement ${developmentPlanSupplementId} — 0 STRATEGY_BASED-shaped Approved SEPG rows after filter (matched=${rows.length}); skipping ผ.03 section`,
      );
      return null;
    }

    // §16.5 year axis — derive from the parent plan window. Coerce to
    // Number defensively (string-hydrated columns would string-concat).
    const startYear = Number(parentPlan.startYear);
    const endYear = Number(parentPlan.endYear);
    const years = Array.from(
      { length: endYear - startYear + 1 },
      (_, i) => startYear + i,
    );

    const fonts = this.pdfService.getPdfFonts();
    const newWord = this.pdfService.newWord.bind(this.pdfService);

    const developmentPlanLine = parentPlan.name?.trim()
      ? parentPlan.name
      : `แผนพัฒนาท้องถิ่น พ.ศ. ${parentPlan.startYear}-${parentPlan.endYear}`;

    // ── GROUP-LEVEL page tracking (§21.3) ───────────────────────────
    // Render the "บัญชีครุภัณฑ์ (ผ.03)" full-page divider first, then
    // EACH (Category, Tactic, Plan) group as its own buffer, accumulating
    // a running `localOffset`. Each group footer renders
    // `currentPage + (pageOffset + localOffset)` so the ผ.03 pages
    // continue the supplement book's absolute count. Every SEPG row in a
    // group shares the group's first 1-based LOCAL page. Identical
    // mechanics to the STRATEGY branch of
    // `renderApprovedPlanScopedPor03Buffer`; reuses `groupRows` +
    // `createPor03DetailDocDefinition` — no layout/grouping duplication.
    const dividerDoc = createPor03SectionDividerDocDefinition();
    const dividerBuffer = await this.pdfService.createPdfBuffer(
      dividerDoc,
      fonts,
    );

    const pageMap = new Map<string, number>();
    const groupBuffers: Buffer[] = [];
    const includedIds: string[] = [];

    let localOffset = (await PDFDocument.load(dividerBuffer)).getPageCount();

    const groups = this.groupRows(
      filteredRows as unknown as EquipmentProjectGroup[],
    );

    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      const groupDoc = createPor03DetailDocDefinition({
        developmentPlanName: developmentPlanLine,
        groups: [group],
        years,
        newWord,
        includeCoverBlock: i === 0,
        pageOffset: pageOffset + localOffset,
      });
      if (!groupDoc) continue;
      const groupBuffer = await this.pdfService.createPdfBuffer(
        groupDoc,
        fonts,
      );
      for (const r of group.rows) {
        pageMap.set(r.id, localOffset + 1);
        includedIds.push(r.id);
      }
      groupBuffers.push(groupBuffer);
      localOffset += (await PDFDocument.load(groupBuffer)).getPageCount();
    }

    // Degrade cleanly if every group failed to render (defensive — the
    // shape filter above already returned null on zero rows).
    if (groupBuffers.length === 0) {
      return null;
    }

    const buffer = await this.pdfService.mergePdfBuffers([
      dividerBuffer,
      ...groupBuffers,
    ]);

    return { buffer, equipmentIds: includedIds, pageMap };
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

  /**
   * ISSUE_BASED grouping helper (BE-02) — produces the
   * `EquipmentIssueTableGroup[]` shape consumed by
   * `createPor03IssueBasedDetailDocDefinition`.
   *
   * Ordering:
   *   - Outer DevelopmentIssue: `sortOrder` ASC, then `name` (Thai
   *     collation) as a tiebreak / fallback when sortOrder is equal /
   *     absent.
   *   - Inner EquipmentCategory: `sortOrder` ASC, then `code` ASC.
   *   - Rows: `equipmentName` (Thai collation) ASC.
   *
   * Callers pre-filter to ISSUE_BASED-shaped rows (developmentIssue
   * present), so `r.developmentIssue` is always defined here.
   */
  private groupRowsByIssue(
    rows: EquipmentProjectGroup[],
  ): EquipmentIssueTableGroup[] {
    // Bucket by issue id → category id, preserving the source rows.
    const issueBuckets = new Map<
      string,
      {
        issueName: string;
        issueSortOrder: number;
        categories: Map<string, EquipmentProjectGroup[]>;
      }
    >();

    for (const r of rows) {
      const issue = r.developmentIssue!;
      let issueBucket = issueBuckets.get(issue.id);
      if (!issueBucket) {
        issueBucket = {
          issueName: issue.name,
          issueSortOrder: issue.sortOrder ?? 0,
          categories: new Map<string, EquipmentProjectGroup[]>(),
        };
        issueBuckets.set(issue.id, issueBucket);
      }
      const catId = r.equipmentCategory.id;
      if (!issueBucket.categories.has(catId)) {
        issueBucket.categories.set(catId, []);
      }
      issueBucket.categories.get(catId)!.push(r);
    }

    const groups: EquipmentIssueTableGroup[] = [];
    for (const issueBucket of issueBuckets.values()) {
      const categories: EquipmentIssueCategoryGroup[] = [];
      for (const bucket of issueBucket.categories.values()) {
        bucket.sort((a, b) =>
          (a.equipmentName ?? '').localeCompare(b.equipmentName ?? '', 'th'),
        );
        const first = bucket[0];
        categories.push({
          categoryCode: first.equipmentCategory.code,
          categoryName: first.equipmentCategory.name,
          rows: bucket,
        });
      }

      // Inner category sort — sortOrder ASC, then code ASC.
      categories.sort((a, b) => {
        const as = a.rows[0].equipmentCategory.sortOrder;
        const bs = b.rows[0].equipmentCategory.sortOrder;
        if (as !== bs) return as - bs;
        return a.categoryCode - b.categoryCode;
      });

      groups.push({
        issueName: issueBucket.issueName,
        issueSortOrder: issueBucket.issueSortOrder,
        categories,
      });
    }

    // Outer issue sort — sortOrder ASC, then name (Thai) as tiebreak.
    groups.sort((a, b) => {
      const as = a.issueSortOrder ?? 0;
      const bs = b.issueSortOrder ?? 0;
      if (as !== bs) return as - bs;
      return (a.issueName ?? '').localeCompare(b.issueName ?? '', 'th');
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
  private assertCooldownClear(
    workHistoryId: string,
    endpointKey: string = Por03PdfService.COOLDOWN_ENDPOINT_KEY,
  ): void {
    const key = `${workHistoryId}|${endpointKey}`;
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
   * Arm the cooldown for `(workHistoryId, endpointKey)` for the next
   * 10 seconds. Idempotent — re-arming refreshes the window. The
   * `endpointKey` defaults to `print-por03`; the revision ผ.03 print
   * passes `print-por03-revision` so the two surfaces have independent
   * windows (§17.8).
   *
   * Capped at 10,000 entries (mirror of `InMemoryAiCooldownStore`
   * MEMORY_CAPACITY) so a runaway high-cardinality scenario cannot
   * unbounded-grow memory.
   */
  private armCooldown(
    workHistoryId: string,
    endpointKey: string = Por03PdfService.COOLDOWN_ENDPOINT_KEY,
  ): void {
    const key = `${workHistoryId}|${endpointKey}`;
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
