import {
  ExecutiveToolName,
  ExecutiveToolSpec,
  ToolJsonSchema,
} from './executive-tool.types';

/**
 * Executive AI Chat — tool whitelist.
 *
 * CLAUDE.md references:
 *   - §17.2 / §17.11 — all tools are READ aggregators. Mutating tools
 *     are explicitly forbidden; a tool whose name is NOT in this map
 *     MUST be rejected by the tool-loop adapter (BE-W44-02) regardless
 *     of the caller's role, including super-admin.
 *   - §17.7 / §16.5 — tools that read classification fields branch on
 *     `reportFormat`; see `getDevelopmentIssues` and
 *     `highlightBudgetOutliers` in particular.
 *   - §17.9 — returned result shape is schema-validated server-side;
 *     `returnSchema` below is the canonical contract.
 *
 * Wave 44 scope expansion (2026-04-23) merges the originally-proposed
 * `detectBottlenecks` + `detectDelayedProjects` into a single
 * `detectWorkflowAgingProjects` tool; the LLM resolves any Thai
 * phrasing ("ค้างนาน"/"คอขวด"/"ล่าช้า") to this tool. See
 * docs/tasks/wave44/BE-W44-01.md §7.4.1.
 */

// Shared schema fragments.
const uuidField: ToolJsonSchema = { type: 'string', format: 'uuid' };
const positiveInt: ToolJsonSchema = { type: 'integer', minimum: 1 };

// ──────────────────────────────────────────────────────────────────────
// Wave 54 BE-W54-06 — Shared ExecutiveQuery DSL fragment.
//
// Registered ONCE as a TS-level shared constant and inlined into each
// Tier C tool's `paramsSchema` (the in-house schema validator does not
// support `$ref`, per design §4 and task §11.R2). Per-tool `planId`
// clauses (§7 LOCKED 2026-04-24):
//   - `getPlanOverview.paramsSchema`              = { ...DSL, required: [...DSL.required, 'planId'] }
//   - `getExecutiveDashboardSnapshot.paramsSchema` = DSL as-is (planId optional)
//   - `getCrossPlanInsights.paramsSchema`          = { ...DSL, properties: { ...DSL.properties, planId: { not: {} } } }
//
// §17.9 defense: every nested object carries `additionalProperties: false`.
// §17.11 no role exemption — role assertion lives in the Tier C
// handlers; the schema is an input-validation gate only.
// ──────────────────────────────────────────────────────────────────────
export const EXECUTIVE_QUERY_SCHEMA: ToolJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scope'],
  properties: {
    planId: { type: 'string', format: 'uuid' },
    scope: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        enum: ['main', 'revision', 'supplement', 'all'],
      },
    },
    includeBudget: { type: 'boolean', default: false },
    // W67 hotfix-3 — `includeStatus` defaults to TRUE across all three
    // executive Tier-C tools. LLMs habitually omit the flag and then
    // hallucinate zeros to fit rule #11b's 4-group template. Defaulting
    // on guarantees `data.executiveStatusBreakdown` is always populated
    // when projects exist. Explicit `false` still opts out.
    // The §17.9 byte-identity contract (dsl-contract.spec) is preserved
    // because the change applies uniformly to all three tools.
    includeStatus: { type: 'boolean', default: true },
    // W67-FIX-B — opt-in hierarchical status drill-down. When `true`
    // AND `includeStatus` resolves true, the dashboardSnapshot envelope
    // additionally exposes `data.statusBreakdownByBook[]` (book × status
    // group × project list) for prompt rule #39's nested-bullets render.
    // §17.2 advisory only — drill does NOT gate any workflow transition.
    // Default OFF (Q1 opt-in) so default snapshots stay token-cheap.
    // Byte-identical across all three Tier-C tools per dsl-contract.spec.
    includeStatusDrill: { type: 'boolean', default: false },
    includeGeo: { type: 'boolean', default: false },
    includeAgency: { type: 'boolean', default: false },
    includeClassification: { type: 'boolean', default: false },
    groupBy: {
      type: 'array',
      uniqueItems: true,
      items: {
        type: 'string',
        // Wave 55 W55-BE-07 — `originType` exposes the derived
        // "โครงการประสานแผน" (lao-coordinated) vs "โครงการปกติ"
        // (agency-normal) discriminator per §1 + §5.
        // W67-LAO-RESOLVER — `'lao'` exposes the per-LAO bucket
        // builder; pairs with `filters.laoIds` for "อปท ใน [อำเภอ X]"
        // breakdowns.
        enum: [
          'status',
          'amphoe',
          'agency',
          'strategy',
          'issue',
          'planLevel',
          'originType',
          'lao',
        ],
      },
    },
    filters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'array', items: { type: 'string' } },
        amphoeIds: { type: 'array', items: { type: 'string' } },
        // W67-LAO-RESOLVER — string PK array filter targeting
        // `${alias}.local_administrative_organization_id`. Mirror of
        // `amphoeIds`; LLM MUST resolve via `listLaos` first per
        // prompt rule #25b — sending Thai literals binds 0 rows.
        laoIds: { type: 'array', items: { type: 'string' } },
        // W67-PAO-VOCAB (2026-04-27) — exclusion-list counterpart to
        // `laoIds`. Used by rule #25c to express "โครงการ อปท / ประสานแผน"
        // = `excludeLaoIds: ['3001027']` (i.e., everything EXCEPT
        // อบจ.นครราชสีมา). Aggregator emits
        // `${alias}.local_administrative_organization_id NOT IN (...) AND IS NOT NULL`
        // so projects without a LAO FK are excluded by symmetry with `laoIds`.
        excludeLaoIds: { type: 'array', items: { type: 'string' } },
        // W67-PAO-EXEC-STAGE (2026-04-27) — execution-stage filters used
        // by rule #25c v3 to express "โครงการของ อบจ" = projects where
        // อบจ. has assigned a department (responsible_agency_id NOT NULL)
        // AND the project has been added to the plan book (isBooked=true).
        //
        // SupplementProjectGroup: has no `isBooked` column (always booked
        // when persisted) and `responsible_agency_id` is NOT NULL by
        // entity constraint, so SPG always passes both filters when set
        // to `true`, and is excluded (1=0) when either filter is set to
        // `false`.
        hasResponsibleAgency: { type: 'boolean' },
        isBooked: { type: 'boolean' },
        // W68-FIX-07 (2026-04-28): government_agency.id is
        // @PrimaryGeneratedColumn() — DB stores integer. Schema flipped
        // 'string' → 'integer' to match the actual column type. Pre-fix,
        // gpt-4o sometimes sent integer (correct shape) but schema demanded
        // string → soft-fail loop → AI gave up. Now schema matches DB and
        // listAgencies must return integer (not String(id)).
        // §17.9 schema strict: integer-only; reject UUIDs / strings.
        // applyFilters coerces via Number() defensively for legacy callers.
        agencyIds: { type: 'array', items: { type: 'integer' } },
        budgetRange: {
          type: 'object',
          additionalProperties: false,
          properties: {
            min: { type: 'number', minimum: 0 },
            max: { type: 'number', minimum: 0 },
          },
        },
        dateRange: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
          },
        },
        // Wave 55 W55-BE-07 — filter projects by derived origin type
        // (§1 + §5). Values: 'lao-coordinated' (โครงการประสานแผน),
        // 'agency-normal' (โครงการปกติ).
        originType: {
          type: 'array',
          uniqueItems: true,
          items: {
            type: 'string',
            enum: ['lao-coordinated', 'agency-normal'],
          },
        },
      },
    },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    // Wave 55 BE-W55-05 — §14.2 lineage-aware aggregation. When `false`
    // (default) the Tier B aggregator returns ONLY head-of-lineage PG /
    // RPG rows, preventing the GAP-3 double-count. When `true`, the HEAD
    // filter is short-circuited for audit/debug only; executive tools
    // SHOULD leave this `false`. Supplement is unaffected (not part of
    // the PG/RPG revision chain).
    includeHistoricalVersions: { type: 'boolean', default: false },
  },
};

/**
 * Deep-clone helper — prevents per-tool `paramsSchema` from sharing a
 * reference with `EXECUTIVE_QUERY_SCHEMA`. Byte-identity of the shared
 * fragment is asserted elsewhere (`dsl-contract.spec.ts`); the per-tool
 * merged schemas diverge on the `planId` clause by design.
 */
function cloneExecutiveQuerySchema(): ToolJsonSchema {
  return JSON.parse(JSON.stringify(EXECUTIVE_QUERY_SCHEMA)) as ToolJsonSchema;
}

// ──────────────────────────────────────────────────────────────────────
// Wave 54 BE-W54-06 — Tier C returnSchema skeletons.
//
// Each Tier C tool returns an ExecutiveEnvelope<T> (see
// aggregation/types/executive-envelope.ts). `data` is tool-specific and
// left as a loose object at the schema layer — BE-W54-07/-08 will tighten
// it via per-shape returnSchema contracts. Meta fields (`shape`, `asOf`,
// `partial`, `missingDimensions`, `advisories`) are strict.
// ──────────────────────────────────────────────────────────────────────
function buildEnvelopeReturnSchema(
  shape: 'planOverview' | 'dashboardSnapshot' | 'crossPlanInsights',
): ToolJsonSchema {
  return {
    type: 'object',
    required: [
      'shape',
      'data',
      'asOf',
      'partial',
      'missingDimensions',
      'advisories',
    ],
    properties: {
      shape: { type: 'string', enum: [shape] },
      data: { type: 'object' },
      asOf: { type: 'string', format: 'date-time' },
      partial: { type: 'boolean' },
      missingDimensions: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'budget',
            'status',
            'geo',
            'geo:supplement',
            'agency',
            'classification',
          ],
        },
      },
      advisories: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Wave 54 BE-W54-06 — Tier C tool specs.
//
// These three Tier C tools are the LLM-preferred surface for
// cross-source executive questions post-Wave 54. Wave 53 tools remain
// registered (demote-not-retire per design §9 / dispatch §11.1); the
// system-prompt catalog rank-orders the new tools FIRST.
// ──────────────────────────────────────────────────────────────────────
const getPlanOverview: ExecutiveToolSpec = {
  name: 'getPlanOverview',
  thaiLabel: 'สรุปภาพรวมของเล่มแผน',
  description:
    'สรุปภาพรวมของเล่มแผน (main + revised + supplement) แบบรวมศูนย์ — จำนวนโครงการ / งบประมาณรวม / สถานะล่าสุด / พื้นที่ / หน่วยงานรับผิดชอบ. ต้องระบุ planId. อ่านอย่างเดียว.',
  paramsSchema: (() => {
    const schema = cloneExecutiveQuerySchema();
    schema.required = [...(schema.required ?? []), 'planId'];
    return schema;
  })(),
  returnSchema: buildEnvelopeReturnSchema('planOverview'),
  handlerPlaceholder: null,
};

const getExecutiveDashboardSnapshot: ExecutiveToolSpec = {
  name: 'getExecutiveDashboardSnapshot',
  thaiLabel: 'สแนปช็อตผู้บริหารตาม DSL',
  description:
    'สแนปช็อตผู้บริหารตาม DSL: เลือกมิติที่ต้องการ (status/amphoe/agency/strategy/issue) ในเล่มเดียวหรือหลายเล่ม. **W103-PR3: ใช้สำหรับ agency-scoped count + budget summaries เป็น tool หลัก** — โดย default จะเดินผ่านทุกเล่มแผน (active + frozen) เมื่อ `planId` ถูกละเว้น. **planId เป็นตัวเลือก — ส่งเฉพาะเมื่อผู้ใช้ระบุชัดเจน** เช่น "เฉพาะแผน X" / "เฉพาะแผน 2566-2570" / "เฉพาะแผนล่าสุด"; ห้ามเดา / ห้าม default ไปที่แผนล่าสุดเงียบ ๆ (W103 regression). **W67: `includeStatus` เปิดเป็น default** — envelope จะคืน `data.executiveStatusBreakdown` (4-group view ตามกฎ #11b) อัตโนมัติ. ส่ง `includeStatus: false` อย่างชัดเจนเพื่อปิด. อ่านอย่างเดียว.',
  paramsSchema: cloneExecutiveQuerySchema(),
  returnSchema: buildEnvelopeReturnSchema('dashboardSnapshot'),
  handlerPlaceholder: null,
};

const getCrossPlanInsights: ExecutiveToolSpec = {
  name: 'getCrossPlanInsights',
  thaiLabel: 'วิเคราะห์ข้ามเล่มแผน',
  description:
    'วิเคราะห์ข้ามเล่มแผน — ไม่ระบุ planId; ใช้ดูแนวโน้มรวม / จัดอันดับ / เปรียบเทียบหลายเล่ม. **W103-PR3 routing preference**: ใช้ tool นี้ **เฉพาะเมื่อ** ผู้ใช้ขอ "เปรียบเทียบ" / "เทียบ" / "rank" ข้ามเล่มอย่างชัดเจน (เช่น "เปรียบเทียบ 2566-2570 กับ 2571-2575" / "จัดอันดับเล่มไหนงบสูงสุด"). **สำหรับคำถาม agency-scoped routine** (count + budget ของหน่วยงาน X) → ใช้ `getExecutiveDashboardSnapshot` แทน (รองรับ all-books default + agency filter ใน tool เดียว). ห้าม split tool ระหว่าง count turn กับ list turn ของ agency เดียวกัน (กฎ #42). อ่านอย่างเดียว.',
  paramsSchema: (() => {
    const schema = cloneExecutiveQuerySchema();
    // Forbid `planId` at the schema level. `{ not: {} }` matches no
    // value, so any payload carrying `planId` is rejected by the
    // in-house validator (§17.9 schema defense).
    schema.properties = {
      ...(schema.properties ?? {}),
      planId: { not: {} },
    };
    return schema;
  })(),
  returnSchema: buildEnvelopeReturnSchema('crossPlanInsights'),
  handlerPlaceholder: null,
};

const listActivePlans: ExecutiveToolSpec = {
  name: 'listActivePlans',
  thaiLabel: 'รายการแผนที่เปิดใช้งาน',
  description:
    'คืนรายการ DevelopmentPlan ทั้งหมดที่ยังไม่ถูกลบ (รวมเล่มเก่าด้วย) พร้อมข้อมูลสรุป: id, ชื่อ, reportFormat, จำนวนโครงการ และ planActivityStatus. ใช้ latestOnly=true เพื่อกรองเฉพาะ isLatest=true. อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      // Wave 59 W59-BE-AGG-01 (D-A) — DEFAULT FLIP.
      // Pre-W59 the param was `includeClosed: boolean` (default false)
      // and the handler defaulted to `isLatest=true`. Users asking
      // "เล่มไหนบ้าง" only saw the single latest row. The new default
      // returns ALL non-soft-deleted plans; opt back in to the old
      // behavior with `latestOnly: true`.
      latestOnly: {
        type: 'boolean',
        default: false,
        description:
          'true เพื่อแสดงเฉพาะแผนล่าสุด (isLatest=true). default false คือคืนทุกเล่มที่ยังไม่ถูกลบ',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 20,
      },
    },
  },
  returnSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            planId: uuidField,
            name: { type: 'string' },
            reportFormat: {
              type: 'string',
              enum: ['STRATEGY_BASED', 'ISSUE_BASED'],
            },
            // Wave 58 W58-BE-AGG-01 / W58-BE-AGG-02 (D1) — paired Thai
            // display label. Empty string is permitted only when the
            // enum value is not in the canonical lookup (defensive
            // fallback).
            reportFormatLabel: { type: 'string' },
            isLatest: { type: 'boolean' },
            isBooked: { type: 'boolean' },
            projectCount: { type: 'integer', minimum: 0 },
            // Wave 58 W58-BE-AGG-03 (D2 — Option B) — structured
            // two-badge envelope: `freshness` ('latest'|'historical')
            // paired with its Thai label, plus an `activities[]` stack
            // covering the four open-state signals (submit-open,
            // edit-open, change-open, supplement-open) with `'none'`
            // emitted as a mutually-exclusive sentinel when ALL four
            // signals are closed. Sorted alphabetical by `key`.
            planActivityStatus: {
              type: 'object',
              required: ['freshness', 'freshnessLabel', 'activities'],
              properties: {
                freshness: {
                  type: 'string',
                  enum: ['latest', 'historical'],
                },
                freshnessLabel: { type: 'string' },
                activities: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['key', 'label'],
                    properties: {
                      key: {
                        type: 'string',
                        enum: [
                          'submit-open',
                          'edit-open',
                          'change-open',
                          'supplement-open',
                          'none',
                        ],
                      },
                      label: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          required: [
            'planId',
            'name',
            'reportFormat',
            'reportFormatLabel',
            'planActivityStatus',
          ],
        },
      },
      asOf: { type: 'string', format: 'date-time' },
    },
    required: ['items', 'asOf'],
  },
  handlerPlaceholder: null,
};

const getDevelopmentIssues: ExecutiveToolSpec = {
  name: 'getDevelopmentIssues',
  thaiLabel: 'รายการประเด็นการพัฒนา',
  description:
    'คืนรายการ DevelopmentIssue ของแผนที่ระบุ (ISSUE_BASED เท่านั้น). หากแผนเป็น STRATEGY_BASED จะคืน items ว่างพร้อมเหตุผล. อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['planId'],
    properties: {
      planId: uuidField,
    },
  },
  returnSchema: {
    type: 'object',
    required: ['planId', 'reportFormat', 'items'],
    properties: {
      planId: uuidField,
      reportFormat: {
        type: 'string',
        enum: ['STRATEGY_BASED', 'ISSUE_BASED'],
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['issueId', 'name'],
          properties: {
            issueId: uuidField,
            name: { type: 'string' },
            projectCount: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
  },
  handlerPlaceholder: null,
};

const getPendingCountsByScope: ExecutiveToolSpec = {
  name: 'getPendingCountsByScope',
  thaiLabel: 'จำนวนงานที่รอดำเนินการ',
  description:
    'สรุปจำนวนโครงการในสถานะ Pending / Pending_Approval แบ่งตาม scope (main / revision / change). อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      scope: {
        type: 'string',
        enum: ['all', 'main', 'revision', 'change'],
        default: 'all',
      },
    },
  },
  returnSchema: {
    type: 'object',
    required: ['items', 'asOf'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['scope', 'status', 'count'],
          properties: {
            scope: {
              type: 'string',
              enum: ['main', 'revision', 'change'],
            },
            status: {
              type: 'string',
              enum: ['Pending', 'Pending_Approval'],
            },
            statusTh: { type: 'string' },
            count: { type: 'integer', minimum: 0 },
          },
        },
      },
      asOf: { type: 'string', format: 'date-time' },
    },
  },
  handlerPlaceholder: null,
};

const getTeamWorkloadSummary: ExecutiveToolSpec = {
  name: 'getTeamWorkloadSummary',
  thaiLabel: 'สรุปภาระงานของทีม',
  // W66-BE-AGG-02 — explicit disclaimer about counter semantics. The
  // prior bland description let the LLM translate `inReviewCount` to
  // "รอแก้ไข" (Returned_For_Revision), which is wrong: that field rolls
  // up Verified + Pending_Approval only. Each counter now has a Thai-
  // label sibling (`*LabelTh`) baked into the envelope (§17.9 static
  // literals). NULL-agency rows surface the W57 rule #26 disclosure.
  description:
    'สรุปจำนวนโครงการที่แต่ละหน่วยงานรับผิดชอบ (assignee = government agency).\n' +
    '- pendingCount = สถานะ Pending เท่านั้น (Thai = รอการอนุมัติ)\n' +
    '- inReviewCount = สถานะ Verified + Pending_Approval รวมกัน (Thai = รอตรวจสอบ + รออนุมัติ)\n' +
    '  ⚠️ inReviewCount ไม่ใช่ Returned_For_Revision (รอแก้ไข) — สถานะ "รอแก้ไข" ต้องใช้ getProjectStatusBreakdown\n' +
    '- approvedCount = สถานะ Approved (Thai = อนุมัติ)\n' +
    'ห้ามใช้ tool นี้ตอบคำถามต่อไปนี้:\n' +
    '- "มีโครงการรอแก้ไขกี่โครงการ" → ใช้ getProjectStatusBreakdown แทน\n' +
    '- "มีโครงการที่ไม่มีหน่วยงานรับผิดชอบไหม" → ใช้ getExecutiveDashboardSnapshot(groupBy=[\'agency\']) แทน\n' +
    'NULL-agency rows ในผลลัพธ์จะมี assigneeDisclosure = "ยังไม่มีหน่วยงานรับผิดชอบ (รอ staff กำหนด)" per W57 rule #26.\n' +
    'อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      scope: {
        type: 'string',
        enum: ['all', 'main', 'revision', 'supplement'],
        default: 'all',
      },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
  },
  returnSchema: {
    type: 'object',
    // W67-BE-AGG-01 — `executiveStatusBreakdown` added as a required
    // sibling of `items[]`. The rollup sums all rows in the workload
    // result and exposes the 4 executive groups (`pendingReviewCount`
    // = Pending; `awaitingApprovalCount` = Verified+Pending_Approval;
    // `approvedCount` = Approved; `rejectedCount` = 0 here — Rejected
    // is not summed by this handler's underlying query, see
    // getProjectStatusBreakdown for the full breakdown).
    required: ['items', 'executiveStatusBreakdown', 'asOf'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          // W66-BE-AGG-02 — `assigneeDisclosure` and `assigneeId` are
          // required-but-nullable per W58 nullable-via-required-only
          // convention: listed in `required[]` so the LLM always sees
          // the field, but omitted from `properties` so the schema
          // validator accepts `null`.
          required: [
            'assigneeId',
            'assigneeLabel',
            'assigneeDisclosure',
            'pendingCount',
            'pendingLabelTh',
            'inReviewCount',
            'inReviewLabelTh',
            'approvedCount',
            'approvedLabelTh',
          ],
          properties: {
            // W66c (2026-04-26) — `assigneeId` per W66-BE-AGG-02 envelope (was
            // `assigneeWorkHistoryId` pre-W66; renamed to match `required[]`).
            // Nullable for unassigned rows (per W57 rule #26 + nullable-via-
            // required-only convention) — type omitted from properties.
            assigneeLabel: { type: 'string' },
            pendingCount: { type: 'integer', minimum: 0 },
            pendingLabelTh: { type: 'string' },
            inReviewCount: { type: 'integer', minimum: 0 },
            inReviewLabelTh: { type: 'string' },
            approvedCount: { type: 'integer', minimum: 0 },
            approvedLabelTh: { type: 'string' },
          },
        },
      },
      // W67-BE-AGG-01 — top-level 4-group rollup. Sum across all rows
      // returned in `items[]`. `rejectedCount` is always 0 here because
      // this handler's underlying query does not select `Rejected` rows;
      // see getProjectStatusBreakdown for the full breakdown.
      executiveStatusBreakdown: {
        type: 'object',
        required: [
          'pendingReviewCount',
          'awaitingApprovalCount',
          'approvedCount',
          'rejectedCount',
        ],
        properties: {
          pendingReviewCount: { type: 'integer', minimum: 0 },
          awaitingApprovalCount: { type: 'integer', minimum: 0 },
          approvedCount: { type: 'integer', minimum: 0 },
          rejectedCount: { type: 'integer', minimum: 0 },
        },
      },
      asOf: { type: 'string', format: 'date-time' },
    },
  },
  handlerPlaceholder: null,
};

// BE-W53-02: widen returnSchema to include per-scope breakdown.  The LLM
// can now answer "how much of plan X's budget is in เล่มแก้ไข /
// เล่มเปลี่ยนแปลง vs เล่มหลัก vs เล่มเพิ่มเติม".  Flat top-level fields
// (`totalBudget`/`projectCount`/`averageBudget`) retain the aggregate
// (main + revised + supplement) sum so the existing prompts that ask a
// plain "งบรวมของแผน X" still see a single number.
const getBudgetSummaryByPlan: ExecutiveToolSpec = {
  name: 'getBudgetSummaryByPlan',
  thaiLabel: 'สรุปงบประมาณตามแผน',
  description:
    'ผลรวมและค่าเฉลี่ยงบประมาณของโครงการในแผน รวม เล่มหลัก (ProjectGroup) + เล่มแก้ไข/เปลี่ยนแปลง (RevisedProjectGroup) + เล่มเพิ่มเติม (SupplementProjectGroup). breakdown แยก main/revised/supplement. อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['planId'],
    properties: {
      planId: uuidField,
    },
  },
  returnSchema: {
    type: 'object',
    required: [
      'planId',
      'totalBudget',
      'projectCount',
      'averageBudget',
      'breakdown',
    ],
    properties: {
      planId: uuidField,
      totalBudget: { type: 'number', minimum: 0 },
      projectCount: { type: 'integer', minimum: 0 },
      averageBudget: { type: 'number', minimum: 0 },
      breakdown: {
        type: 'object',
        required: ['main', 'revised', 'supplement'],
        properties: {
          main: {
            type: 'object',
            required: ['totalBudget', 'projectCount'],
            properties: {
              totalBudget: { type: 'number', minimum: 0 },
              projectCount: { type: 'integer', minimum: 0 },
            },
          },
          revised: {
            type: 'object',
            required: ['totalBudget', 'projectCount'],
            properties: {
              totalBudget: { type: 'number', minimum: 0 },
              projectCount: { type: 'integer', minimum: 0 },
            },
          },
          supplement: {
            type: 'object',
            required: ['totalBudget', 'projectCount'],
            properties: {
              totalBudget: { type: 'number', minimum: 0 },
              projectCount: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
      asOf: { type: 'string', format: 'date-time' },
    },
  },
  handlerPlaceholder: null,
};

// BE-W53-02: add optional `planId` filter so the LLM can scope the
// keyword search to a single plan (e.g. "ค้นคำว่า ถนน ในแผน X").  The
// `keyword` param remains the sole free-text input — prompt-injection
// delimiters + schema validation shape unchanged per §17.9.
const searchProjectsByKeyword: ExecutiveToolSpec = {
  name: 'searchProjectsByKeyword',
  thaiLabel: 'ค้นหาโครงการด้วยคำค้น',
  description:
    'ค้นหาโครงการจาก เล่มหลัก (ProjectGroup) / เล่มแก้ไข-เปลี่ยนแปลง (RevisedProjectGroup) / เล่มเพิ่มเติม (SupplementProjectGroup) ด้วยคำค้น (ชื่อโครงการ). ถ้าระบุ planId จะจำกัดผลลัพธ์เฉพาะโครงการที่ผูกกับแผนนั้น. อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['keyword'],
    properties: {
      keyword: { type: 'string' },
      scope: {
        type: 'string',
        enum: ['all', 'main', 'revision', 'supplement'],
        default: 'all',
      },
      planId: uuidField,
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
  },
  returnSchema: {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          // W60c (2026-04-25 — round 5) — `searchProjectsByKeyword` envelope
          // enriched to mirror `listProjectsInPlan` items (responsibleAgencyName,
          // budget, pageNumber, objective, amphoeName, laoName, geoCoordinates,
          // revisionRoundLabel/Type/Id, etc.). Nullable fields are listed in
          // `required` (presence enforced) but OMITTED from `properties` so
          // the in-house validator's no-nullable-string limitation doesn't
          // reject them at runtime — same convention as listProjectsInPlan.
          required: [
            'projectId',
            'projectKind',
            'name',
            'planId',
            'currentStatus',
            'statusTh',
            // W67-BE-AGG-01 — computed 4-group executive rollup field
            // (nullable for workflow-internal statuses).
            'executiveStatus',
            'responsibleAgencyName',
            'responsibleAgencyDisclosure',
            'revisionRoundType',
            'revisionRoundId',
            'revisionRoundLabel',
            'pageNumber',
            'objective',
            'objectiveTruncated',
            // Wave 62 W62-BE-AGG-01 — extended classification fields.
            // `goal` / `expected` are nullable text (omitted from
            // `properties` per the nullable-via-required-only convention).
            // `indicator` and `developmentIssueLabel` are §16.5
            // mutually-exclusive (driven by parent plan's reportFormat).
            'goal',
            'goalTruncated',
            'expected',
            'expectedTruncated',
            'indicator',
            'developmentIssueLabel',
            'amphoeName',
            'laoName',
            'geoCoordinates',
          ],
          properties: {
            projectId: uuidField,
            projectKind: {
              type: 'string',
              enum: ['original', 'revised', 'supplement'],
            },
            name: { type: 'string' },
            // planId omitted from properties (nullable for unbound search rows)
            // currentStatus / statusTh omitted (nullable when no tracking row)
            // ditto for the rest of the nullable rich fields below
          },
        },
      },
      asOf: { type: 'string', format: 'date-time' },
    },
  },
  handlerPlaceholder: null,
};

const getProjectStatusBreakdown: ExecutiveToolSpec = {
  name: 'getProjectStatusBreakdown',
  thaiLabel: 'สัดส่วนสถานะโครงการ',
  description:
    'นับจำนวนโครงการในแต่ละสถานะ (Ready / Pending / Verified / Pending_Approval / Approved / Returned_For_Revision / Pull_Back). อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      planId: uuidField,
      scope: {
        type: 'string',
        enum: ['all', 'main', 'revision', 'supplement'],
        default: 'all',
      },
    },
  },
  returnSchema: {
    type: 'object',
    // W67-BE-AGG-01 — `executiveStatusBreakdown` is now a required
    // sibling of `items[]`. The 4-group rollup is computed from the
    // same `countByStatus` map; surfacing it as an explicit envelope
    // field lets the LLM cite "รอตรวจสอบ"/"รออนุมัติ"/"อนุมัติ"/
    // "เกินศักยภาพ" totals without re-translating the per-status
    // English names. §17.2 advisory only.
    required: ['items', 'executiveStatusBreakdown', 'asOf'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['status', 'count'],
          properties: {
            status: { type: 'string' },
            statusTh: { type: 'string' },
            count: { type: 'integer', minimum: 0 },
          },
        },
      },
      executiveStatusBreakdown: {
        type: 'object',
        required: [
          'pendingReviewCount',
          'awaitingApprovalCount',
          'approvedCount',
          'rejectedCount',
        ],
        properties: {
          pendingReviewCount: { type: 'integer', minimum: 0 },
          awaitingApprovalCount: { type: 'integer', minimum: 0 },
          approvedCount: { type: 'integer', minimum: 0 },
          rejectedCount: { type: 'integer', minimum: 0 },
        },
      },
      asOf: { type: 'string', format: 'date-time' },
    },
  },
  handlerPlaceholder: null,
};

const getApprovalPipelineSnapshot: ExecutiveToolSpec = {
  name: 'getApprovalPipelineSnapshot',
  thaiLabel: 'ภาพรวมสายการอนุมัติ',
  description:
    'ภาพรวมขั้นตอนการอนุมัติ (queue depth และเวลาเฉลี่ยต่อขั้น) สำหรับ main plan / revision / change. อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      scope: {
        type: 'string',
        enum: ['all', 'main', 'revision', 'change'],
        default: 'all',
      },
    },
  },
  returnSchema: {
    type: 'object',
    required: ['stages', 'asOf'],
    properties: {
      stages: {
        type: 'array',
        items: {
          type: 'object',
          required: ['fromStatus', 'toStatus', 'queueDepth'],
          properties: {
            fromStatus: { type: 'string' },
            fromStatusTh: { type: 'string' },
            toStatus: { type: 'string' },
            toStatusTh: { type: 'string' },
            queueDepth: { type: 'integer', minimum: 0 },
            avgHoursInStage: { type: 'number', minimum: 0 },
          },
        },
      },
      asOf: { type: 'string', format: 'date-time' },
    },
  },
  handlerPlaceholder: null,
};

const detectWorkflowAgingProjects: ExecutiveToolSpec = {
  name: 'detectWorkflowAgingProjects',
  thaiLabel: 'โครงการค้างนาน / คอขวด / ล่าช้า',
  description:
    'คืนรายการโครงการที่อยู่ในสถานะ Pending หรือ Pending_Approval มานานกว่า thresholdDays วัน (default 14). ไม่รวม Returned_For_Revision และ Pull_Back เพราะเป็นสถานะฝั่งเจ้าของ. อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      thresholdDays: {
        type: 'integer',
        minimum: 1,
        maximum: 180,
        default: 14,
      },
      scope: {
        type: 'string',
        enum: ['all', 'main', 'revision', 'change'],
        default: 'all',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
      },
    },
  },
  returnSchema: {
    type: 'object',
    required: ['items', 'thresholdDays', 'asOf'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'projectId',
            'projectKind',
            'name',
            'currentStatus',
            'statusTh',
            // W67-BE-AGG-01 — computed 4-group executive rollup field
            // (Pending → pending_review; Pending_Approval → awaiting_approval).
            'executiveStatus',
            'enteredStatusAt',
            'ageDays',
          ],
          properties: {
            projectId: uuidField,
            projectKind: {
              type: 'string',
              enum: ['original', 'revised'],
            },
            name: { type: 'string' },
            currentStatus: {
              type: 'string',
              enum: ['Pending', 'Pending_Approval'],
            },
            statusTh: { type: 'string' },
            // executiveStatus is a string union — list in required[] for
            // presence; type narrowing is via `enum` to satisfy the
            // schema-drift validator. Both eligible statuses map to
            // non-null groups (Pending → pending_review; Pending_Approval
            // → awaiting_approval) so the field is never null here.
            executiveStatus: {
              type: 'string',
              enum: ['pending_review', 'awaiting_approval'],
            },
            enteredStatusAt: { type: 'string', format: 'date-time' },
            ageDays: { type: 'integer', minimum: 1 },
            planId: uuidField,
            amphoeId: { type: 'integer' },
            responsibleAgencyId: { type: 'integer' },
          },
        },
      },
      thresholdDays: positiveInt,
      asOf: { type: 'string', format: 'date-time' },
    },
  },
  handlerPlaceholder: null,
};

const highlightBudgetOutliers: ExecutiveToolSpec = {
  name: 'highlightBudgetOutliers',
  thaiLabel: 'งบประมาณสูงผิดปกติ',
  description:
    'หาโครงการที่งบประมาณสูงผิดปกติ "ภายในแผนเดียวกัน" ด้วยวิธี percentile (default) หรือ stddev. ไม่ใช่การเปรียบเทียบกับ "งบที่ควรจะเป็น" และไม่รวมโครงการ under-budget. อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['planId'],
    properties: {
      planId: uuidField,
      method: {
        type: 'string',
        enum: ['percentile', 'stddev'],
        default: 'percentile',
      },
      threshold: {
        type: 'number',
        description:
          'percentile: 0.90–0.99 (default 0.95); stddev: 1.0–4.0 (default 2.0)',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 30,
        default: 10,
      },
    },
  },
  returnSchema: {
    type: 'object',
    required: ['items', 'planId', 'method', 'asOf'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'projectId',
            'projectKind',
            'name',
            'budget',
            'rank',
            'reason',
          ],
          properties: {
            projectId: uuidField,
            projectKind: {
              type: 'string',
              enum: ['original', 'revised', 'supplement'],
            },
            name: { type: 'string' },
            budget: { type: 'number', minimum: 0 },
            planId: uuidField,
            rank: { type: 'integer', minimum: 1 },
            reason: { type: 'string' },
          },
        },
      },
      planId: uuidField,
      method: {
        type: 'string',
        enum: ['percentile', 'stddev'],
      },
      threshold: { type: 'number' },
      asOf: { type: 'string', format: 'date-time' },
    },
  },
  handlerPlaceholder: null,
};

// ──────────────────────────────────────────────────────────────────────
// Wave 48 (BE-W48-03): listProjectsInPlan
//
// Enumerates ProjectGroup rows bound to a given `planId`. Closes the gap
// that caused "ขอรายละเอียดเพิ่มเติม" follow-ups to fall back to
// `searchProjectsByKeyword` (keyword-only, no planId filter) and return
// empty. Wave 48 restricts `scope` to `main` — RevisedProjectGroup and
// SupplementProjectGroup enumeration is deferred to a follow-up wave.
//
// §17.2 advisory read aggregator. §17.3 — READS project tables but
// persists NO new FK from ai_* into any project table. §17.7 / §16.5
// — does NOT read classification fields (strategy/tactic/plan/
// developmentIssue/indicator); safe across both reportFormat values.
// ──────────────────────────────────────────────────────────────────────
// BE-W53-02: widen `scope` to honour `main | revised | supplement | all`.
// Each non-main row carries its version metadata inline:
//   - revised   → `revisionNumber` (int) + `revisionTypeName` (แก้ไข /
//                 เปลี่ยนแปลง / other) as siblings of `projectKind`.
//   - supplement → `supplementNumber` (int) as sibling of `projectKind`.
// The `projectKind` enum is widened accordingly; legacy callers that send
// `scope=main` continue to see only `original` rows.
const listProjectsInPlan: ExecutiveToolSpec = {
  name: 'listProjectsInPlan',
  thaiLabel: 'รายการโครงการในแผน',
  description:
    'คืนรายการโครงการที่ผูกกับแผนตาม planId ที่ระบุ. รองรับ scope = main (เล่มหลัก) | revised (เล่มแก้ไข/เปลี่ยนแปลง) | supplement (เล่มเพิ่มเติม) | all. สำหรับ scope=all จะแบ่งโควตา limit ระหว่างสามกลุ่ม (main ~50%, revised ~30%, supplement ส่วนที่เหลือ) และไม่เกิน limit รวม. ใช้เมื่อต้องการ enumerate โครงการในแผน (ห้ามใช้ searchProjectsByKeyword เพื่อจุดประสงค์นี้). **W68-FIX-05 (2026-04-28)**: รองรับพารามิเตอร์ `verbose: boolean` (default `false`) สำหรับเปิดโหมดแสดงฟิลด์เพิ่มเติม (วัตถุประสงค์ / เป้าหมาย / ผลที่คาดว่าจะได้รับ / ตัวชี้วัด / ประเด็นการพัฒนา) ใน `renderedMarkdown`. ส่ง `verbose: true` **เฉพาะเมื่อ** ข้อความผู้ใช้มี trigger word จากกฎ #30 (เช่น "ทุกคอลัมน์" / "พร้อมรายละเอียด" / "และวัตถุประสงค์" / "พร้อมตัวชี้วัด"); ค่าปกติให้ละเว้นหรือส่ง `false`. อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['planId'],
    properties: {
      // Wave 60c (2026-04-25): drop strict `format: 'uuid'` here. The
      // handler at executive-tool-handlers.ts:1393-1402 already validates
      // the UUID shape and returns a friendly hint envelope ("planId
      // ต้องเป็น UUID ที่ได้จาก listActivePlans...") that the LLM can act
      // on. The schema validator's UUID format check was firing BEFORE
      // the handler, throwing "$.planId: not a UUID" and crashing the
      // turn before the LLM could see the hint. Schema now accepts any
      // string; runtime validation is owned by the handler.
      planId: { type: 'string' },
      scope: {
        type: 'string',
        enum: ['main', 'revised', 'supplement', 'all'],
        // W60c (2026-04-25) — flip default 'main' → 'all'. The prior
        // 'main' default caused the LLM to silently miss revised+change
        // RPG rows when the user asked "ข้อมูลล่าสุดของโครงการในแผน X"
        // (Mode 2 / byRevisionRound) without explicitly passing scope.
        // 'all' is the safer default for chat — comprehensive view; LLM
        // can narrow with `scope='main'` only when user says "เล่มหลัก"
        // / "main only".
        default: 'all',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 20,
      },
      // Wave 58 W58-BE-AGG-01 (D4) — opt-in `groupBy=byRevisionRound`
      // mode. When omitted, the handler returns the flat `items[]`
      // shape; when set to `byRevisionRound`, the handler returns a
      // `groups[]` shape keyed by `(revisionRoundType, revisionRoundId)`
      // so `edit` and `change` rounds are NEVER co-mingled. Currently
      // the only valid value is `'byRevisionRound'`; future grouping
      // modes (e.g. `byAgency`, `byAmphoe`) will widen the accepted set
      // — encoded as a `string` (with a description constraint) rather
      // than a single-value enum to satisfy the §17.9 schema-drift
      // single-enum guard.
      // Wave 60 W60-BE-AGG-01 — `byBookCompleteness` joins
      // `byRevisionRound` as a recognized value. Under
      // `byBookCompleteness` HEAD-of-lineage filtering is SKIPPED so
      // historical rows (whose HEAD now lives in a later book) remain
      // visible; each row carries an additional `isHead: boolean` flag.
      // Soft-delete (`deletedAt IS NULL`) and Ready-hidden filters still
      // apply in this mode. Backward compatibility — `byRevisionRound`
      // and the unset (default) mode keep their Wave 58/59 semantics
      // exactly. Encoded as a `string` (with description constraint)
      // rather than an `enum` to preserve the W58 single-enum-guard
      // posture; the handler treats unknown values as "no grouping".
      groupBy: {
        type: 'string',
        description:
          'รูปแบบการจัดกลุ่ม: "byRevisionRound" จัดกลุ่มตามรอบเล่ม (HEAD-only). "byBookCompleteness" แสดงทุกเล่มที่มีโครงการ (รวมเล่มเก่าที่ถูก supersede แล้ว) และเพิ่มฟิลด์ isHead ในแต่ละแถว. ค่าอื่นจะถูกละเว้น',
      },
      // W68-FIX-05 (2026-04-28) — opt-in verbose-mode gate for the
      // server-rendered `renderedMarkdown` body. When `false` (default),
      // the markdown emits only the core fields per prompt rule #30
      // (ชื่อโครงการ / สถานะ / หน่วยงานรับผิดชอบ / งบประมาณ / หน้า) and
      // appends a discreet hint footer telling the user how to opt in.
      // When `true`, the five verbose fields are added: วัตถุประสงค์ /
      // เป้าหมาย / ผลที่คาดว่าจะได้รับ / ตัวชี้วัด / ประเด็นการพัฒนา.
      // The LLM MUST set `verbose: true` ONLY when the user message
      // contains a trigger word from rule #30's trigger list (e.g.
      // "ทุกคอลัมน์", "พร้อมรายละเอียด", "และวัตถุประสงค์",
      // "พร้อมตัวชี้วัด"). §17.2 advisory-only — this gate is
      // display-only and never affects workflow transitions.
      verbose: { type: 'boolean', default: false },
    },
  },
  returnSchema: {
    type: 'object',
    // Wave 58 W58-BE-AGG-01 — `items` is no longer mandatory at the
    // top level; the envelope is a discriminated union: either
    // `items[]` (default) OR `groups[]` (when `groupBy=byRevisionRound`).
    // `planId` and `asOf` remain mandatory.
    required: ['planId', 'asOf'],
    properties: {
      planId: uuidField,
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'projectId',
            'projectKind',
            'name',
            'currentStatus',
            'statusTh',
            // W67-BE-AGG-01 — computed 4-group executive rollup field
            // (value MAY be null when status is workflow-internal:
            // Ready / Pull_Back / Returned_For_Revision). Listed in
            // `required[]` and OMITTED from `properties` per the
            // W58 nullable-via-required-only convention.
            'executiveStatus',
            // Wave 58 D3 / D4 — agency-name + round metadata are now
            // ALWAYS-present envelope keys (value MAY be null).
            'responsibleAgencyName',
            'responsibleAgencyDisclosure',
            'revisionRoundType',
            'revisionRoundId',
            'revisionRoundLabel',
            // Wave 58 W58-BE-AGG-03 (D7) — `pageNumber` is ALWAYS
            // surfaced as a key on every project row (value MAY be null
            // when the book is not yet compiled / not booked). This
            // follows the W58-BE-AGG-02 nullable-via-required-only
            // convention — listed under `required` so presence is
            // asserted; no explicit `properties` entry because the
            // in-house validator has no nullable-int shape.
            'pageNumber',
            // Wave 59 W59-BE-AGG-01 (D-B) — objective + truncation
            // flag. `objective` may be null (no value recorded);
            // `objectiveTruncated` is always boolean. Listed under
            // `required` for presence assertion; `objective` itself is
            // omitted from `properties` (nullable-string follows the
            // W58-BE-AGG-02 nullable-via-required-only convention).
            'objective',
            'objectiveTruncated',
            // Wave 62 W62-BE-AGG-01 — extended classification fields.
            // `goal` / `expected` mirror the `objective` shape (text +
            // truncation flag). `indicator` and `developmentIssueLabel`
            // are §16.5 mutually-exclusive — exactly one is non-null per
            // row, driven by the parent plan's reportFormat (§17.7).
            'goal',
            'goalTruncated',
            'expected',
            'expectedTruncated',
            'indicator',
            'developmentIssueLabel',
            // Wave 59 W59-BE-AGG-01 (D-C) — location triple. amphoeName
            // and laoName may be null (relation FK absent). geoCoordinates
            // may be null when both start and end pairs are missing.
            'amphoeName',
            'laoName',
            'geoCoordinates',
          ],
          properties: {
            projectId: uuidField,
            projectKind: {
              type: 'string',
              enum: ['original', 'revised', 'supplement'],
            },
            name: { type: 'string' },
            currentStatus: { type: 'string' },
            statusTh: { type: 'string' },
            planId: uuidField,
            budget: { type: 'number', minimum: 0 },
            amphoeId: { type: 'integer' },
            responsibleAgencyId: { type: 'integer' },
            // Wave 58 W58-BE-AGG-01 (D3 / D6) — JOIN-projected agency
            // name; null when the FK is null. NEVER a synthesized
            // placeholder (handler asserts placeholder-free via
            // `assertAgencyLabelPlaceholderFree`). Nullable per the
            // contract — `responsibleAgencyName` and
            // `responsibleAgencyDisclosure` are intentionally NOT
            // declared in `properties` (only listed under `required` so
            // the key-presence check fires) because the in-house schema
            // validator (`tool-schema-validator.ts`) has no
            // `type:[string,null]` shape and would reject `null` values
            // for any typed property. Runtime contract is `string | null`
            // and is enforced by `buildProjectEntry()` in the handler.
            // Wave 58 W58-BE-AGG-01 (D4) — round-grouping metadata.
            revisionRoundType: {
              type: 'string',
              enum: ['main', 'edit', 'change', 'supplement'],
            },
            // `revisionRoundId` is also nullable (null for `main`) and
            // is treated identically — required-key check only.
            revisionRoundLabel: { type: 'string' },
            // Revised-only sibling fields (populated when projectKind='revised').
            revisionNumber: { type: 'integer', minimum: 1 },
            revisionTypeName: { type: 'string' },
            // Supplement-only sibling field (populated when projectKind='supplement').
            supplementNumber: { type: 'integer', minimum: 1 },
            // Wave 59 W59-BE-AGG-01 (D-B) — `objectiveTruncated` is a
            // mandatory boolean (presence asserted via `required`,
            // type asserted here). `objective`, `amphoeName`, `laoName`,
            // and `geoCoordinates` are nullable and intentionally OMITTED
            // from `properties` per the W58-BE-AGG-02
            // nullable-via-required-only convention — runtime contract
            // is enforced by `buildProjectEntry()`.
            objectiveTruncated: { type: 'boolean' },
            // Wave 62 W62-BE-AGG-01 — `goalTruncated` / `expectedTruncated`
            // are mandatory booleans (presence asserted via `required`,
            // type asserted here). `goal`, `expected`, `indicator`, and
            // `developmentIssueLabel` are nullable and intentionally
            // OMITTED from `properties` per the W58-BE-AGG-02
            // nullable-via-required-only convention.
            goalTruncated: { type: 'boolean' },
            expectedTruncated: { type: 'boolean' },
          },
        },
      },
      // Wave 58 W58-BE-AGG-01 (D4) — discriminated-union sibling.
      // Only present when `groupBy=byRevisionRound` was requested.
      groups: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'revisionRoundType',
            'revisionRoundId',
            'revisionRoundLabel',
            'projects',
          ],
          properties: {
            revisionRoundType: {
              type: 'string',
              enum: ['main', 'edit', 'change', 'supplement'],
            },
            // Wave 58 — `revisionRoundId` is nullable (null for `main`)
            // and is intentionally OMITTED from `properties` since the
            // in-house validator has no nullable-string shape. The key
            // is still listed under `required` so presence is asserted;
            // type is checked at runtime by the handler shaper.
            revisionRoundLabel: { type: 'string' },
            projects: {
              type: 'array',
              items: { type: 'object' },
            },
          },
        },
      },
      // W60c (2026-04-25) — server-rendered markdown body for
      // `byBookCompleteness` mode. Optional in schema (only present in
      // Mode A); LLM is instructed to emit verbatim per rule #32.
      renderedMarkdown: { type: 'string' },
      // W60c round 4 — thin group summary (label + count only) emitted
      // alongside `renderedMarkdown`. Replaces full `groups[]` in Mode A
      // so the LLM has no structured row data to dedup-render against
      // the markdown body. Optional; not in `required`.
      groupSummary: {
        type: 'array',
        items: { type: 'object' },
      },
      asOf: { type: 'string', format: 'date-time' },
    },
  },
  handlerPlaceholder: null,
};

// ──────────────────────────────────────────────────────────────────────
// Wave 53 (BE-W53-03): getProjectClassificationBreakdown
//
// Surfaces project classification groupings per plan, correctly branching
// on the parent `DevelopmentPlan.reportFormat` per CLAUDE.md §17.7 and
// preserving the §16.5 exactly-one-shape invariant:
//   - STRATEGY_BASED plan → group counts by Strategy → Tactic → Plan.
//   - ISSUE_BASED plan → group counts by DevelopmentIssue.
//
// Wave 53 scope: main-plan PG only. RevisedProjectGroup / SupplementProjectGroup
// classification breakdown deferred to a follow-up wave (task §4).
//
// §17.2 advisory read aggregator. §17.3 — READS project tables but
// persists NO new FK from ai_* into any project table.
// ──────────────────────────────────────────────────────────────────────
const getProjectClassificationBreakdown: ExecutiveToolSpec = {
  name: 'getProjectClassificationBreakdown',
  thaiLabel: 'สรุปการจัดหมวดโครงการตามแผน',
  description:
    'สรุปจำนวนโครงการในแผนตาม planId แยกตามโครงสร้างการจัดหมวด. ' +
    'ถ้าแผนเป็น STRATEGY_BASED จะแบ่งตาม ยุทธศาสตร์ → กลยุทธ์ → แผนงาน. ' +
    'ถ้าเป็น ISSUE_BASED จะแบ่งตาม ประเด็นการพัฒนา. ' +
    'ถ้าไม่ระบุ planId จะคืนผลแบบ dual-bucket ทั้ง STRATEGY_BASED และ ISSUE_BASED. อ่านอย่างเดียว.',
  // Wave 57 W57-BE-AGG-04 — `planId` is now OPTIONAL. When omitted the
  // handler returns a dual-bucket result (Section A: STRATEGY_BASED,
  // Section B: ISSUE_BASED) and emits the `dual-bucket-classification`
  // advisory.
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { planId: uuidField },
  },
  returnSchema: {
    type: 'object',
    // Wave 57 W57-BE-AGG-04 — `shape` may now be `'dual-bucket'` when
    // the caller omits `planId`. In that case `items` is empty and the
    // breakdown is exposed via `partitions` (one entry per format).
    required: ['shape'],
    properties: {
      planId: uuidField,
      reportFormat: {
        type: 'string',
        enum: ['STRATEGY_BASED', 'ISSUE_BASED'],
      },
      shape: {
        type: 'string',
        enum: ['strategy', 'issue', 'dual-bucket'],
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          // Deliberately NOT setting `required` narrowly because the
          // two shapes populate different key-sets. The handler emits
          // exactly one shape per call; the LLM uses the top-level
          // `shape` discriminator to branch.
          properties: {
            // STRATEGY_BASED keys
            strategyId: uuidField,
            strategyName: { type: 'string' },
            tacticId: uuidField,
            tacticName: { type: 'string' },
            planLevelId: uuidField,
            planLevelName: { type: 'string' },
            sampleIndicator: { type: 'string' },
            // ISSUE_BASED keys
            issueId: uuidField,
            issueName: { type: 'string' },
            // Common
            projectCount: { type: 'integer', minimum: 0 },
          },
        },
      },
      // Wave 57 W57-BE-AGG-04 — dual-bucket payload.
      partitions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['reportFormat', 'shape', 'items'],
          properties: {
            reportFormat: {
              type: 'string',
              enum: ['STRATEGY_BASED', 'ISSUE_BASED'],
            },
            shape: { type: 'string', enum: ['strategy', 'issue'] },
            items: { type: 'array', items: { type: 'object' } },
          },
        },
      },
      advisories: { type: 'array', items: { type: 'string' } },
      asOf: { type: 'string', format: 'date-time' },
      message: { type: 'string' },
    },
  },
  handlerPlaceholder: null,
};

// ──────────────────────────────────────────────────────────────────────
// Wave 53 (BE-W53-02): listDevelopmentPlanRevisions
//
// Enumerates DevelopmentPlanRevision rounds of a plan with type
// (แก้ไข / เปลี่ยนแปลง / other), isLatest, isOpen, isBooked, and the
// count of distinct RevisedProjectGroup rows in each round.  Closes the
// gap that previously had no tool exposure for "มีรอบแก้ไขอะไรบ้าง".
//
// §17.2 advisory read aggregator.  §17.3 — no new FK from ai_* into any
// project table.  §17.11 `assertExecutiveRole` enforced in the handler.
// ──────────────────────────────────────────────────────────────────────
const listDevelopmentPlanRevisions: ExecutiveToolSpec = {
  name: 'listDevelopmentPlanRevisions',
  thaiLabel: 'รายการรอบแก้ไข/เปลี่ยนแปลงของแผน',
  description:
    'คืนรายการ DevelopmentPlanRevision ของแผนตาม planId พร้อมประเภท (แก้ไข / เปลี่ยนแปลง) สถานะเปิด และจำนวนโครงการในรอบนั้น. อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['planId'],
    properties: {
      planId: uuidField,
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  },
  returnSchema: {
    type: 'object',
    required: ['planId', 'items', 'asOf'],
    properties: {
      planId: uuidField,
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'revisionId',
            'revisionNumber',
            'revisionTypeName',
            'isLatest',
            'isOpen',
            'isBooked',
            'projectCount',
          ],
          properties: {
            revisionId: uuidField,
            revisionNumber: { type: 'integer', minimum: 1 },
            revisionTypeName: { type: 'string' },
            isLatest: { type: 'boolean' },
            isOpen: { type: 'boolean' },
            isBooked: { type: 'boolean' },
            projectCount: { type: 'integer', minimum: 0 },
          },
        },
      },
      asOf: { type: 'string', format: 'date-time' },
    },
  },
  handlerPlaceholder: null,
};

// ──────────────────────────────────────────────────────────────────────
// Wave 53 (BE-W53-02): listDevelopmentPlanSupplements
//
// Enumerates DevelopmentPlanSupplement books of a plan with
// supplementNumber, isLatest, isOpen, isBooked and the count of distinct
// SupplementProjectGroup rows per book.
// ──────────────────────────────────────────────────────────────────────
const listDevelopmentPlanSupplements: ExecutiveToolSpec = {
  name: 'listDevelopmentPlanSupplements',
  thaiLabel: 'รายการเล่มเพิ่มเติมของแผน',
  description:
    'คืนรายการ DevelopmentPlanSupplement ของแผนตาม planId พร้อม supplementNumber, สถานะเปิด, จำนวนโครงการในเล่ม. อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['planId'],
    properties: {
      planId: uuidField,
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  },
  returnSchema: {
    type: 'object',
    required: ['planId', 'items', 'asOf'],
    properties: {
      planId: uuidField,
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'supplementId',
            'supplementNumber',
            'isLatest',
            'isOpen',
            'isBooked',
            'projectCount',
          ],
          properties: {
            supplementId: uuidField,
            supplementNumber: { type: 'integer', minimum: 1 },
            isLatest: { type: 'boolean' },
            isOpen: { type: 'boolean' },
            isBooked: { type: 'boolean' },
            projectCount: { type: 'integer', minimum: 0 },
          },
        },
      },
      asOf: { type: 'string', format: 'date-time' },
    },
  },
  handlerPlaceholder: null,
};

// ──────────────────────────────────────────────────────────────────────
// Wave 53 (BE-W53-02): getProjectLocationBreakdown
//
// Per-อำเภอ (amphoe) counts + total budget under a given planId.
// Scope enum: main | revised | supplement | all.  NOTE: SupplementProjectGroup
// does NOT carry an `amphoe_id` column (see
// `supplement-project-group.entity.ts`) so the `supplement` scope is
// EXCLUDED from the breakdown and `scope='supplement'` returns an empty
// items array with an advisory `message`.  `scope='all'` silently
// aggregates only `main + revised`.  This exclusion is documented in
// the tool description per task §7.9.
// ──────────────────────────────────────────────────────────────────────
const getProjectLocationBreakdown: ExecutiveToolSpec = {
  name: 'getProjectLocationBreakdown',
  thaiLabel: 'สรุปโครงการรายอำเภอ',
  description:
    'คืนจำนวนโครงการและงบประมาณรวมในแต่ละอำเภอ ภายใต้ planId ที่กำหนด. รองรับ scope = main (เล่มหลัก) | revised (เล่มแก้ไข/เปลี่ยนแปลง) | supplement (เล่มเพิ่มเติม) | all. ข้อจำกัด: SupplementProjectGroup ไม่มีคอลัมน์ amphoe_id จึงถูกตัดออกจากผลสรุป (scope=supplement คืน items ว่าง; scope=all รวมเฉพาะ main+revised). อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['planId'],
    properties: {
      planId: uuidField,
      scope: {
        type: 'string',
        enum: ['main', 'revised', 'supplement', 'all'],
        default: 'all',
      },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  },
  returnSchema: {
    type: 'object',
    required: ['planId', 'scope', 'items', 'asOf'],
    properties: {
      planId: uuidField,
      scope: {
        type: 'string',
        enum: ['main', 'revised', 'supplement', 'all'],
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['amphoeId', 'amphoeName', 'projectCount', 'totalBudget'],
          properties: {
            amphoeId: { type: 'integer' },
            amphoeName: { type: 'string' },
            projectCount: { type: 'integer', minimum: 0 },
            totalBudget: { type: 'number', minimum: 0 },
          },
        },
      },
      asOf: { type: 'string', format: 'date-time' },
      message: { type: 'string' },
    },
  },
  handlerPlaceholder: null,
};

// ──────────────────────────────────────────────────────────────────────
// Wave 61 — Mode 3 lineage tools.
//
// `getProjectHeadBook(projectId)` answers "เล่มล่าสุดของโครงการ X" —
// it walks forward from any PG/RPG/SPG row to the HEAD-of-lineage and
// reports the book the HEAD currently lives in.
//
// `getProjectLineage(projectId)` answers "ไทม์ไลน์โครงการ X" — it walks
// both directions (root PG → HEAD) and returns the ordered chain with
// per-step book metadata.
//
// §10 — every walk uses the row's own plan chain. §14.2 — HEAD-of-lineage
// stops at the first row with no live RPG descendant. §17.2 advisory.
// §17.3 read-only — no FK from ai_* into any project table.
// ──────────────────────────────────────────────────────────────────────
const getProjectHeadBook: ExecutiveToolSpec = {
  name: 'getProjectHeadBook',
  thaiLabel: 'เล่มล่าสุดของโครงการ',
  description:
    'คืน "เล่มล่าสุด" (HEAD-of-lineage) ของโครงการที่ระบุด้วย projectId. รับ UUID ของ ProjectGroup / RevisedProjectGroup / SupplementProjectGroup ก็ได้. ระบบจะเดินไปข้างหน้าตามลูกของ lineage จนถึงเวอร์ชันล่าสุด แล้วบอกว่า HEAD อยู่ในเล่มไหน (เล่มหลัก / เล่มแก้ไขครั้งที่ N / เล่มเปลี่ยนแปลงครั้งที่ N / เล่มเพิ่มเติมครั้งที่ N). อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['projectId'],
    properties: {
      projectId: uuidField,
    },
  },
  returnSchema: {
    type: 'object',
    required: [
      'projectId',
      'headProjectId',
      'headBookLabel',
      'headBookType',
      'isInputHead',
      'advisories',
      'asOf',
    ],
    properties: {
      projectId: uuidField,
      headProjectId: uuidField,
      headBookLabel: { type: 'string' },
      headBookType: {
        type: 'string',
        enum: ['main', 'edit', 'change', 'supplement'],
      },
      headRevisionNumber: { type: 'integer', minimum: 1 },
      headDprId: uuidField,
      headDpsId: uuidField,
      isInputHead: { type: 'boolean' },
      advisories: { type: 'array', items: { type: 'string' } },
      asOf: { type: 'string', format: 'date-time' },
    },
  },
  handlerPlaceholder: null,
};

const getProjectLineage: ExecutiveToolSpec = {
  name: 'getProjectLineage',
  thaiLabel: 'ไทม์ไลน์โครงการ',
  description:
    'คืนไทม์ไลน์ lineage ของโครงการ (ProjectGroup / RevisedProjectGroup / SupplementProjectGroup) แบบเรียงตั้งแต่ต้น (เล่มหลัก) ไปจนถึง HEAD ล่าสุด. แต่ละ step มี bookLabel + bookType + revisionNumber + dprId/dpsId + ชื่อโครงการ + statusName + isHead. SupplementProjectGroup ไม่ได้อยู่ใน chain ของ PG/RPG จึงคืน chain เดี่ยว. อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['projectId'],
    properties: {
      projectId: uuidField,
    },
  },
  returnSchema: {
    type: 'object',
    required: [
      'projectId',
      'rootProjectId',
      'headProjectId',
      'chain',
      'asOf',
      'advisories',
    ],
    properties: {
      projectId: uuidField,
      rootProjectId: uuidField,
      headProjectId: uuidField,
      chain: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'projectId',
            'projectKind',
            'bookLabel',
            'bookType',
            'title',
            'isHead',
            'step',
          ],
          properties: {
            projectId: uuidField,
            projectKind: {
              type: 'string',
              enum: ['main', 'revised', 'supplement'],
            },
            bookLabel: { type: 'string' },
            bookType: {
              type: 'string',
              enum: ['main', 'edit', 'change', 'supplement'],
            },
            revisionNumber: { type: 'integer', minimum: 1 },
            dprId: uuidField,
            dpsId: uuidField,
            title: { type: 'string' },
            statusName: { type: 'string' },
            isHead: { type: 'boolean' },
            step: { type: 'integer', minimum: 0 },
          },
        },
      },
      advisories: { type: 'array', items: { type: 'string' } },
      asOf: { type: 'string', format: 'date-time' },
    },
  },
  handlerPlaceholder: null,
};

// ──────────────────────────────────────────────────────────────────────
// Wave 66 W66-BE-AGG-01 — listProjectsWithoutResponsibleAgency
//
// Dedicated lister + counter for the "ไม่มีหน่วยงานรับผิดชอบ" question.
// Filter is a hard `responsible_agency_id IS NULL` predicate; walks the
// THREE source tables (PG / RPG-edit / RPG-change) and returns
// `totalCount` + `scopeBreakdown` + `items[]` so the LLM can answer both
// "กี่โครงการ" and "โครงการอะไรบ้าง" from a single tool call.
//
// Disambiguation note (W57 rule #26): null FK is a DATA STATE
// (LAO-origin row awaiting staff assignment per §5.2), NOT a workflow
// status. Do NOT confuse with `getTeamWorkloadSummary.inReviewCount`
// which counts projects in workflow-review states. Routing rule lives in
// W66-BE-PROMPT-01.
//
// §17.2 advisory only. §17.3 read-only. §17.7 — does NOT read
// classification fields, safe across both reportFormat values.
// §17.11 — `assertExecutiveRole` enforced in the handler.
// Wave 54 — entity property paths only (no raw SQL literals).
// ──────────────────────────────────────────────────────────────────────
const listProjectsWithoutResponsibleAgency: ExecutiveToolSpec = {
  name: 'listProjectsWithoutResponsibleAgency',
  thaiLabel: 'โครงการที่ยังไม่มีหน่วยงานรับผิดชอบ',
  description:
    'นับและคืนรายการโครงการที่ยังไม่มีหน่วยงานรับผิดชอบ (responsible_agency_id IS NULL) ครอบคลุม 3 แหล่งข้อมูล: เล่มหลัก (ProjectGroup) + เล่มแก้ไข (RevisedProjectGroup type=แก้ไข) + เล่มเปลี่ยนแปลง (RevisedProjectGroup type=เปลี่ยนแปลง). ' +
    'รองรับ planId แบบ optional (ไม่ระบุ = ทั้งจังหวัด). scope ได้แก่ all/main/edit/change. คืน totalCount + scopeBreakdown (main/edit/change) + items[]. ' +
    'หมายเหตุ (W57 rule #26): "ไม่มีหน่วยงานรับผิดชอบ" คือสถานะของข้อมูล (NULL FK) ของโครงการที่ลงนามโดย LAO และรอ staff กำหนด ตาม §5.2 — ไม่ใช่สถานะ workflow. ห้ามสับสนกับ getTeamWorkloadSummary.inReviewCount ที่นับโครงการที่อยู่ในสถานะ workflow review. อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      planId: uuidField,
      scope: {
        type: 'string',
        enum: ['all', 'main', 'edit', 'change'],
        default: 'all',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        // W66-AGG-01 ceiling matches the SEC-W44-01 runaway-hops guard
        // (every tool's `limit.maximum` ≤ 50 to bound per-hop payload).
        maximum: 50,
        default: 30,
      },
    },
  },
  returnSchema: {
    type: 'object',
    required: ['totalCount', 'scopeBreakdown', 'items', 'asOf'],
    properties: {
      // `planId` is nullable (omitted when caller did not supply one);
      // intentionally NOT declared in `properties` per the W58-BE-AGG-02
      // nullable-via-required-only convention. Runtime contract enforced
      // by the handler.
      totalCount: { type: 'integer', minimum: 0 },
      scopeBreakdown: {
        type: 'object',
        required: ['main', 'edit', 'change'],
        properties: {
          main: { type: 'integer', minimum: 0 },
          edit: { type: 'integer', minimum: 0 },
          change: { type: 'integer', minimum: 0 },
        },
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'projectId',
            'projectKind',
            'title',
            'planId',
            'planName',
            'revisionRoundLabel',
            'revisionRoundId',
            'pageNumber',
            'budget',
            'amphoeName',
            'laoName',
            'statusname',
            'statusTh',
            // W67-BE-AGG-01 — computed 4-group executive rollup field
            // (nullable for workflow-internal statuses).
            'executiveStatus',
            'responsibleAgencyDisclosure',
          ],
          properties: {
            projectId: uuidField,
            projectKind: {
              type: 'string',
              enum: ['main', 'edit', 'change'],
            },
            title: { type: 'string' },
            planId: uuidField,
            planName: { type: 'string' },
            // W66c (2026-04-26) — `pageNumber` ALSO nullable (null when
            // book not yet compiled / `isBooked=false`). Joined the
            // nullable-via-required-only set below to fix runtime
            // schema-drift error: "$.items[0].pageNumber: expected
            // integer, got null".
            //
            // revisionRoundLabel, revisionRoundId, statusname, amphoeName,
            // laoName, pageNumber are nullable (null for `main`-kind rows
            // or when the FK / book-page is absent). Listed under
            // `required` for presence; OMITTED from `properties` per the
            // nullable-via-required-only convention.
            statusTh: { type: 'string' },
            budget: { type: 'number', minimum: 0 },
            responsibleAgencyDisclosure: { type: 'string' },
          },
        },
      },
      asOf: { type: 'string', format: 'date-time' },
    },
  },
  handlerPlaceholder: null,
};

// ──────────────────────────────────────────────────────────────────────
// Wave 67 W67-AMPHOE-FIX-PROMPT-01 (Path A) — listAmphoes resolver.
//
// Problem closed (CTO investigation
// `docs/tasks/wave67/W67-AMPHOE-FILTER-ZERO-RESULTS.md`): aggregator's
// `applyFilters({ amphoeIds })` binds correctly to `pg.amphoe_id`
// (string PK at `unified-project-aggregator.service.ts:1880-1899`), but
// the prompt's rule #25 documented the filter shape with NO resolver
// tool. LLMs sent the Thai literal verbatim ("อำเภอเมืองนครราชสีมา"),
// SQL bind matched zero rows, chat returned "0 บาท" with a confident
// "ขอบเขต: อำเภอเมืองนครราชสีมา" badge from rule #15.
//
// This tool maps amphoe name (or partial Thai phrase) → PK string the
// LLM then sends as `filters.amphoeIds`. Single province deployment
// (§13.5) — the `amphoes` table contains only Nakhon Ratchasima rows
// so no `changwat` filter is needed (entity has no changwat relation
// either; see `amphoe.entity.ts`).
//
// §17.2 advisory only. §17.3 read-only. §17.7 reportFormat-agnostic
// (amphoe is format-independent). §17.9 — `additionalProperties: false`
// at the schema layer; the handler additionally trims `nameContains`
// and treats whitespace-only / empty input as "omitted" (returns the
// full list rather than a no-op LIKE). §17.11 — role re-checked in
// handler via `assertExecutiveRole`.
// ──────────────────────────────────────────────────────────────────────
const listAmphoes: ExecutiveToolSpec = {
  name: 'listAmphoes',
  thaiLabel: 'รายการอำเภอ',
  description:
    'คืนรายการอำเภอในจังหวัดนครราชสีมา (id + ชื่อ) เพื่อใช้ resolve อำเภอชื่อไทย → amphoe.id PK ก่อนส่งเป็น filter อาทิ filters.amphoeIds. กรอง name ด้วย nameContains ถ้าต้องการลด token; ห้ามแต่ง id เอง. อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      nameContains: {
        type: 'string',
        description:
          'คำค้นบางส่วนของชื่ออำเภอ (case-insensitive partial match). ถ้าไม่ระบุจะคืนทุกอำเภอในจังหวัด.',
      },
    },
  },
  returnSchema: {
    type: 'object',
    required: ['items', 'asOf', 'missingDimensions', 'advisories', 'partial'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['amphoeId', 'name'],
          properties: {
            amphoeId: { type: 'string' },
            name: { type: 'string' },
          },
        },
      },
      asOf: { type: 'string', format: 'date-time' },
      missingDimensions: { type: 'array', items: { type: 'string' } },
      advisories: { type: 'array', items: { type: 'string' } },
      partial: { type: 'boolean' },
    },
  },
  handlerPlaceholder: null,
};

// ──────────────────────────────────────────────────────────────────────
// Wave 67 W67-LAO-RESOLVER — listLaos resolver.
//
// Mirror of `listAmphoes`. Maps LAO name (or partial Thai phrase) →
// `local_administrative_organizations.id` (string PK). Required because
// the new `filters.laoIds` clause on the shared ExecutiveQuery DSL
// targets the project's own `local_administrative_organization_id`
// column, and the LLM has no path to translate "อบต. โคกกรวด" → the
// PK without a resolver — sending the Thai literal binds 0 rows.
//
// Hybrid validation (Q2=c locked 2026-04-26): the schema accepts both
// params optionally, and the HANDLER additionally enforces at-least-
// one-of `{ amphoeId, nameContains }` so a single call cannot dump all
// 430+ rows province-wide. Empty-payload calls return `items: []` with
// advisory `'lao-filter-required'` instead of throwing — matches the
// envelope shape the LLM already understands.
//
// §17.2 advisory only. §17.3 read-only. §17.7 reportFormat-agnostic
// (LAO is format-independent). §17.9 — `additionalProperties: false`
// at the schema layer; the handler additionally trims whitespace-only
// inputs as "omitted" (so `nameContains: '   '` does NOT count as a
// filter for the at-least-one-of check). §17.11 — role re-checked in
// handler via `assertExecutiveRole`. §13.5 changwat scope inherited
// from the underlying table population (single-province deployment —
// Nakhon Ratchasima).
// ──────────────────────────────────────────────────────────────────────
const listLaos: ExecutiveToolSpec = {
  name: 'listLaos',
  thaiLabel: 'รายการ อปท.',
  description:
    'คืนรายการองค์กรปกครองส่วนท้องถิ่น (อปท.) ในจังหวัดนครราชสีมา (id + ชื่อ + ประเภท + อำเภอ) เพื่อใช้ resolve อปท ชื่อไทย → laoId PK ก่อนส่งเป็น filter อาทิ filters.laoIds. ต้องระบุ amphoeId, nameContains หรือ type อย่างน้อย 1 ตัว (ป้องกัน return ครบ 430+ รายการ); สามารถใช้ร่วมกันได้. **W68-FIX-11 (2026-04-28)**: รองรับ exact-match `type` filter (เช่น "อบต." / "เทศบาลตำบล" / "เทศบาลเมือง" / "เทศบาลนคร") สำหรับ type-aware lookup ตามกฎ #25b Path A — เมื่อ user query มี LAO type prefix (เช่น "อบต. โคกกรวด") ให้ส่ง `type` พร้อม `nameContains` เพื่อยืนยันว่า LAO type ตรง; ถ้าไม่พบให้ fallback retry โดยตัด type ออก แล้วเสนอ alternative ของ type อื่นที่ชื่อใกล้เคียง. ห้ามแต่ง id เอง. อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      amphoeId: {
        type: 'string',
        description:
          'amphoe.id PK (string). ใช้ resolve ผ่าน listAmphoes ก่อน. ถ้าไม่ระบุต้องส่ง nameContains หรือ type แทน.',
      },
      nameContains: {
        type: 'string',
        description:
          'คำค้นบางส่วนของชื่อ อปท (case-insensitive partial match). ถ้าไม่ระบุต้องส่ง amphoeId หรือ type แทน.',
      },
      // W68-FIX-11 (2026-04-28) — exact-match type filter for LAO category.
      // Common values: 'อบต.', 'เทศบาลตำบล', 'เทศบาลเมือง', 'เทศบาลนคร'.
      // Strict equality match against `local_administrative_organizations.type`
      // column. Used when user query specifies an LAO type prefix (e.g.,
      // "อบต. โคกกรวด" → type='อบต.'). When omitted, no type filter is
      // applied. See prompt rule #25b Path A for type-detection logic +
      // fallback behavior when the (type, name) combo returns 0 rows.
      type: {
        type: 'string',
        description:
          'exact-match LAO type (เช่น "อบต." / "เทศบาลตำบล" / "เทศบาลเมือง" / "เทศบาลนคร"). ใช้คู่กับ nameContains สำหรับ type-aware lookup ตามกฎ #25b Path A.',
      },
    },
  },
  returnSchema: {
    type: 'object',
    required: ['items', 'asOf', 'missingDimensions', 'advisories', 'partial'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['laoId', 'name', 'type', 'amphoeId', 'amphoeName'],
          properties: {
            laoId: { type: 'string' },
            name: { type: 'string' },
            type: { type: 'string' },
            amphoeId: { type: 'string' },
            amphoeName: { type: 'string' },
          },
        },
      },
      asOf: { type: 'string', format: 'date-time' },
      missingDimensions: { type: 'array', items: { type: 'string' } },
      advisories: { type: 'array', items: { type: 'string' } },
      partial: { type: 'boolean' },
    },
  },
  handlerPlaceholder: null,
};

// ──────────────────────────────────────────────────────────────────────
// Wave 67 W67-AGENCY-RESOLVER — listAgencies resolver.
//
// Mirror of `listAmphoes` / `listLaos`. Maps government-agency name (or
// partial Thai phrase) → `government_agencies.id` (auto-increment integer
// PK; typed as string at the TS layer per the entity definition). The
// existing aggregator filter `applyFilters({ agencyIds })` already coerces
// via `Number(x)` so the bind shape is unchanged — this tool only closes
// the prompt-side gap that prevented the LLM from emitting the integer
// PK for "ขอดูโครงการของกองยุทธ" / "ขอดูรายชื่อหน่วยงาน".
//
// No at-least-one-of guard (Q2=c style for `listLaos`) — agencies are
// the ~40 departments under อบจ.นครราชสีมา (vs 430+ LAOs province-wide),
// so returning the full list when no filter is provided is acceptable
// token-wise.
//
// §17.2 advisory only. §17.3 read-only — single SELECT against
// `government_agencies`. §17.7 reportFormat-agnostic (agency is
// format-independent). §17.9 — `additionalProperties: false` at the
// schema layer; the handler additionally trims `nameContains` and
// treats whitespace-only / empty input as "omitted". §17.11 — role
// re-checked in handler via `assertExecutiveRole`.
// ──────────────────────────────────────────────────────────────────────
const listAgencies: ExecutiveToolSpec = {
  name: 'listAgencies',
  thaiLabel: 'รายการหน่วยงาน อบจ.',
  description:
    'คืนรายการหน่วยงานราชการ (government_agency) ที่ใช้เป็น responsible_agency_id ของโครงการ — สำหรับ resolve ชื่อหน่วยงาน → agencyId PK ก่อนส่งเป็น filter อาทิ filters.agencyIds. กรอง name ด้วย nameContains; ถ้าไม่ระบุจะคืนทุกหน่วยงาน. ห้ามแต่ง id เอง. อ่านอย่างเดียว.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      nameContains: {
        type: 'string',
        description:
          'คำค้นบางส่วนของชื่อหน่วยงาน (case-insensitive partial match). ถ้าไม่ระบุจะคืนทุกหน่วยงาน.',
      },
    },
  },
  returnSchema: {
    type: 'object',
    required: ['items', 'asOf', 'missingDimensions', 'advisories', 'partial'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['agencyId', 'name'],
          properties: {
            // W68-FIX-07 (2026-04-28): government_agency.id is
            // @PrimaryGeneratedColumn() integer; schema flipped from
            // 'string' → 'integer' to match DB. The LLM reads this
            // integer and sends it back verbatim as filters.agencyIds[i].
            agencyId: { type: 'integer' },
            name: { type: 'string' },
          },
        },
      },
      asOf: { type: 'string', format: 'date-time' },
      missingDimensions: { type: 'array', items: { type: 'string' } },
      advisories: { type: 'array', items: { type: 'string' } },
      partial: { type: 'boolean' },
    },
  },
  handlerPlaceholder: null,
};

export const EXECUTIVE_TOOL_REGISTRY: Record<
  ExecutiveToolName,
  ExecutiveToolSpec
> = {
  listActivePlans,
  getDevelopmentIssues,
  getPendingCountsByScope,
  getTeamWorkloadSummary,
  getBudgetSummaryByPlan,
  searchProjectsByKeyword,
  getProjectClassificationBreakdown,
  getProjectStatusBreakdown,
  getApprovalPipelineSnapshot,
  detectWorkflowAgingProjects,
  highlightBudgetOutliers,
  listProjectsInPlan,
  // BE-W53-02 additions — grouped at tail in stable alphabetical order
  // within the Wave 53 coverage-extension block so BE-W53-03 merges
  // cleanly against this file.
  getProjectLocationBreakdown,
  listDevelopmentPlanRevisions,
  listDevelopmentPlanSupplements,
  // Wave 54 BE-W54-06 — Tier C surface. Three DSL-driven tools that
  // compose Tier B aggregation services. Wave 53 tools above remain
  // registered (demote-not-retire per design §9 / dispatch §11.1).
  getPlanOverview,
  getExecutiveDashboardSnapshot,
  getCrossPlanInsights,
  // Wave 61 — Mode 3 lineage tools (HEAD-book + full-chain).
  getProjectHeadBook,
  getProjectLineage,
  // Wave 66 W66-BE-AGG-01 — explicit "no responsibleAgency" lister
  // (NULL FK across PG / RPG-edit / RPG-change). Disambiguates from
  // `getTeamWorkloadSummary.inReviewCount` per W57 rule #26.
  listProjectsWithoutResponsibleAgency,
  // Wave 67 W67-AMPHOE-FIX-PROMPT-01 (Path A) — amphoe name → PK
  // resolver. Closes the prompt-rule gap that caused executive chat
  // to return zero rows when scoping by amphoe (the LLM sent Thai
  // literals as `filters.amphoeIds` instead of string PKs).
  listAmphoes,
  // Wave 67 W67-LAO-RESOLVER — LAO name → PK resolver. Mirror of
  // `listAmphoes`; pairs with the new `filters.laoIds` clause on the
  // shared ExecutiveQuery DSL.
  listLaos,
  // Wave 67 W67-AGENCY-RESOLVER — government-agency name → PK resolver.
  // Mirror of `listAmphoes` / `listLaos`; pairs with the existing
  // `filters.agencyIds` clause on the shared ExecutiveQuery DSL (which
  // already coerces values via `Number(x)` since the agency PK is an
  // auto-increment integer column).
  listAgencies,
};

/**
 * Convenience accessor used by BE-W44-02 tool-loop adapter.
 * Returns `undefined` for any unknown name — the adapter MUST reject.
 */
export function getExecutiveToolSpec(
  name: string,
): ExecutiveToolSpec | undefined {
  return (EXECUTIVE_TOOL_REGISTRY as Record<string, ExecutiveToolSpec>)[name];
}

export const EXECUTIVE_TOOL_NAMES: ReadonlyArray<ExecutiveToolName> =
  Object.keys(EXECUTIVE_TOOL_REGISTRY) as ExecutiveToolName[];
