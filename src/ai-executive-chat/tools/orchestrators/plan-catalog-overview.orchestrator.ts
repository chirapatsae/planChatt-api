/**
 * Wave AI-EXEC-CHAT-ENTERPRISE-OUTPUT-TONE / BE-01 — Plan Catalog Overview
 * orchestrator.
 *
 * Q1-Q5 lock acknowledgement (from
 * docs/tasks/wave-ai-exec-chat-enterprise-output-tone/README.md §0):
 *   Q1 — 'none' activity badge → SILENCE (omit suffix; do NOT emit
 *        "ไม่มีกิจกรรมเปิด"/"(none)"/placeholder).
 *   Q2 — Bullet rendering enforcement → server-side pre-render via
 *        `renderedMarkdown` envelope field; prompt teaches verbatim emit.
 *   Q3 — Empty-bucket negative-space → renderer never produces empty
 *        bullets; defense-in-depth via prompt FORBIDDEN list (BE-02).
 *   Q4 — No other fragile rules.
 *   Q5 — Rule #48 "Enterprise Output Bar" appended (BE-02 concern).
 *
 * CLAUDE.md cross-references:
 *   §17.2 advisory-only — read-only orchestrator; no `.save`/`.update`/
 *     `.remove` mutation; does NOT gate any workflow transition.
 *   §17.9 — composer uses STATIC Thai literals only; no user-controlled
 *     string flows into the markdown body.
 *   §17.11 no role exemption — handler MUST NOT branch on role; the role
 *     gate is the canonical `assertExecutiveRole` check at the FIRST
 *     statement of the handler.
 *
 * Tool contract (FROZEN — see README §0):
 *
 *   Name: `getPlanCatalogOverview`
 *   Description (Thai): "ดึงภาพรวมทุกเล่มแผน + เล่มย่อย ในรอบเดียว — คืน
 *     renderedMarkdown ที่ประกอบเสร็จแล้วสำหรับ LLM ใช้ verbatim ตามกฎ #47
 *     + #48. ใช้เมื่อ user ถาม general plan listing ('มีเล่มแผนอะไรบ้าง' /
 *     'มีกี่แผน' / 'แผนทั้งหมด')"
 *   Input params: { latestOnly?: boolean (default false),
 *                   includeSubBooks?: boolean (default true) }
 *   Output envelope:
 *     {
 *       plans: PlanEntry[],
 *       revisionsByPlanId: Record<string, RevisionEntry[]>,
 *       supplementsByPlanId: Record<string, SupplementEntry[]>,
 *       renderedMarkdown: string,
 *       metadata: {
 *         generatedAt: ISO timestamp,
 *         documentVersion: '1.0',
 *         totalPlans, expandedPlans, deferredPlans
 *       }
 *     }
 */

import { Logger } from '@nestjs/common';
import {
  ExecutiveToolHandler,
  assertExecutiveRole,
} from '../handlers/handler-types';
import type { PlanActivityStatus } from '../../aggregation/constants/plan-activity-status';

// Sibling handler resolver — lazy `require` to avoid circular import with
// `executive-tool-handlers.ts` (the handlers file imports the orchestrator
// at module-load to wire the EXECUTIVE_TOOL_HANDLERS map). Resolved
// inside the handler body so the module graph stabilizes before the
// orchestrator first runs.
type SiblingHandlerMap = {
  listActivePlans: ExecutiveToolHandler;
  listDevelopmentPlanRevisions: ExecutiveToolHandler;
  listDevelopmentPlanSupplements: ExecutiveToolHandler;
};

function resolveSiblingHandlers(): SiblingHandlerMap {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../handlers/executive-tool-handlers');
  const map = mod.EXECUTIVE_TOOL_HANDLERS as Record<
    string,
    ExecutiveToolHandler
  >;
  return {
    listActivePlans: map.listActivePlans,
    listDevelopmentPlanRevisions: map.listDevelopmentPlanRevisions,
    listDevelopmentPlanSupplements: map.listDevelopmentPlanSupplements,
  };
}

// Logger surface — STABLE label per BE-01 telemetry hook spec (QA-01 will
// grep this string verbatim during the 2-week observation window).
const TELEMETRY_LABEL = 'ai-executive-chat-telemetry:plan-catalog-overview';
const orchestratorLogger = new Logger(
  'AiExecutiveChat:PlanCatalogOverviewOrchestrator',
);

// ──────────────────────────────────────────────────────────────────────
// Envelope shapes
// ──────────────────────────────────────────────────────────────────────

export interface PlanEntry {
  planId: string;
  name: string;
  reportFormat: string;
  reportFormatLabel?: string;
  isLatest: boolean;
  isBooked: boolean;
  projectCount: number;
  planActivityStatus: PlanActivityStatus;
}

export interface RevisionEntry {
  revisionId: string;
  revisionNumber: number;
  revisionTypeName: string;
  isLatest: boolean;
  isOpen: boolean;
  isBooked: boolean;
  projectCount: number;
}

export interface SupplementEntry {
  supplementId: string;
  supplementNumber: number;
  isLatest: boolean;
  isOpen: boolean;
  isBooked: boolean;
  projectCount: number;
}

export interface PlanCatalogMetadata {
  generatedAt: string;
  documentVersion: '1.0';
  totalPlans: number;
  expandedPlans: number;
  deferredPlans: number;
}

export interface PlanCatalogOverviewEnvelope {
  plans: PlanEntry[];
  revisionsByPlanId: Record<string, RevisionEntry[]>;
  supplementsByPlanId: Record<string, SupplementEntry[]>;
  renderedMarkdown: string;
  metadata: PlanCatalogMetadata;
}

// ──────────────────────────────────────────────────────────────────────
// Composer constants — STATIC Thai literals (§17.9).
// ──────────────────────────────────────────────────────────────────────

const TOKEN_BUDGET_PLAN_THRESHOLD = 5;
const SUB_BOOK_CAP = 10;
const COLLAPSED_HINT_SUFFIX = ' (ดูเล่มย่อยได้เมื่อต้องการ)';
const OVERFLOW_BULLET = (n: number) => `(+${n} เล่มอื่น)`;

// ──────────────────────────────────────────────────────────────────────
// Pure composer — unit-testable; no I/O; no LLM input.
//
// CommonMark bullet marker: MUST use `- ` (ASCII hyphen + space).
// The Unicode `•` (U+2022) is NOT a CommonMark list marker and react-
// markdown v10 will render `•` lines as paragraph text, not as a list.
// Tailwind's `list-disc marker:text-slate-400` (frontend/src/page/
// executive/aiChat/markdownComponents.tsx) supplies the visual `•` glyph
// at render time. Confirmed by BE-03 of Wave AI-EXEC-CHAT-ENTERPRISE-
// OUTPUT-TONE-01 (2026-05-29).
//
// Layout (canonical Rule #47):
//
//   **{planLabel}** — {freshnessLabel}{activitySuffix}
//   - {subBookLabel} — {openStateLabel} · มีโครงการ N โครงการ
//   - {subBookLabel} — {openStateLabel} · มีโครงการ N โครงการ
//
//   **{planLabel}** — {freshnessLabel}{activitySuffix}
//   - {subBookLabel} — {openStateLabel} · มีโครงการ N โครงการ
//
// Silence rules:
//   - Q1: when `planActivityStatus.activities[]` is empty OR the sole
//     entry has key='none', do NOT emit ANY activity suffix.
//   - Q3: when a plan has zero revisions AND zero supplements, do NOT
//     emit ANY bullet under it.
//
// Token-budget mitigation:
//   - When `totalPlans > 5`, only `isLatest === true` plans get sub-book
//     expansion; other plans render header + COLLAPSED_HINT_SUFFIX.
//   - Per-plan cap of 10 revisions + 10 supplements inline; overflow →
//     first 10 + "(+N เล่มอื่น)" footer bullet.
// ──────────────────────────────────────────────────────────────────────

export interface ComposerInput {
  plans: PlanEntry[];
  revisionsByPlanId: Record<string, RevisionEntry[]>;
  supplementsByPlanId: Record<string, SupplementEntry[]>;
}

export interface ComposerResult {
  renderedMarkdown: string;
  expandedPlans: number;
  deferredPlans: number;
}

/**
 * Sub-book bullet builder. `openStateLabel`:
 *   isOpen=true  → 'กำลังเปิดรับ'
 *   isOpen=false → 'ปิดอยู่'
 * Per Rule #46 isOpen translation (anti-prose-translation lock).
 */
function openStateLabel(isOpen: boolean): string {
  return isOpen ? 'กำลังเปิดรับ' : 'ปิดอยู่';
}

function revisionBullet(r: RevisionEntry): string {
  // Use revisionType + revisionNumber to compose canonical label.
  // Map Thai revisionType vocabulary to the canonical "เล่มแก้ไข" /
  // "เล่มเปลี่ยนแปลง" prefix. Default to 'เล่มแก้ไข' for unknown values
  // (W58-BE-AGG-01 fallback). §17.9 — values are bounded to DB-managed
  // RevisionType.name strings (Thai 'แก้ไข' / 'เปลี่ยนแปลง' or English
  // 'edit' / 'change'); no user-controlled prose flows here.
  const rtRaw = (r.revisionTypeName ?? '').trim();
  const rtLower = rtRaw.toLowerCase();
  const isChange = rtLower === 'change' || rtRaw.includes('เปลี่ยนแปลง');
  const prefix = isChange ? 'เล่มเปลี่ยนแปลงครั้งที่' : 'เล่มแก้ไขครั้งที่';
  const label = `${prefix} ${r.revisionNumber}`;
  return `- ${label} — ${openStateLabel(r.isOpen)} · มีโครงการ ${r.projectCount} โครงการ`;
}

function supplementBullet(s: SupplementEntry): string {
  const label = `เล่มเพิ่มเติมครั้งที่ ${s.supplementNumber}`;
  return `- ${label} — ${openStateLabel(s.isOpen)} · มีโครงการ ${s.projectCount} โครงการ`;
}

/**
 * Sort sub-books: revisions ASC by (revisionTypeName, revisionNumber)
 * with 'edit' before 'change' to match historical UI grouping;
 * supplements ASC by supplementNumber. Per BE-01 §3.
 */
function sortRevisions(rs: RevisionEntry[]): RevisionEntry[] {
  const rankType = (name: string): number => {
    const t = (name ?? '').trim().toLowerCase();
    if (t === 'change' || (name ?? '').includes('เปลี่ยนแปลง')) return 1;
    return 0; // 'edit' / unknown / 'แก้ไข'
  };
  return [...rs].sort((a, b) => {
    const ra = rankType(a.revisionTypeName);
    const rb = rankType(b.revisionTypeName);
    if (ra !== rb) return ra - rb;
    return (a.revisionNumber ?? 0) - (b.revisionNumber ?? 0);
  });
}

function sortSupplements(ss: SupplementEntry[]): SupplementEntry[] {
  return [...ss].sort(
    (a, b) => (a.supplementNumber ?? 0) - (b.supplementNumber ?? 0),
  );
}

/**
 * Build the activity suffix.
 *   - Empty activities[] OR sole entry key='none' → '' (Q1 silence).
 *   - Otherwise → ' · ' + labels.join(' · ')
 */
function buildActivitySuffix(status: PlanActivityStatus | undefined): string {
  if (!status || !Array.isArray(status.activities)) return '';
  const visible = status.activities.filter((a) => a && a.key !== 'none');
  if (visible.length === 0) return '';
  return ' · ' + visible.map((a) => a.label).join(' · ');
}

function freshnessLabelOf(status: PlanActivityStatus | undefined): string {
  return (status?.freshnessLabel ?? '').trim();
}

/**
 * Pure composer. Returns the canonical Rule #47 markdown block plus
 * metadata counters (expandedPlans / deferredPlans).
 */
export function composePlanCatalogMarkdown(
  input: ComposerInput,
): ComposerResult {
  const { plans, revisionsByPlanId, supplementsByPlanId } = input;
  if (!plans.length) {
    return {
      renderedMarkdown: '',
      expandedPlans: 0,
      deferredPlans: 0,
    };
  }

  const totalPlans = plans.length;
  const tokenBudgetTriggered = totalPlans > TOKEN_BUDGET_PLAN_THRESHOLD;
  let expandedPlans = 0;
  let deferredPlans = 0;

  const blocks: string[] = [];

  for (const plan of plans) {
    const freshness = freshnessLabelOf(plan.planActivityStatus);
    const activitySuffix = buildActivitySuffix(plan.planActivityStatus);

    // Header line. `freshness` is always non-empty in practice (the
    // structured envelope always carries either 'เล่มล่าสุด' or 'เล่มเก่า')
    // but defensive: if freshness is somehow empty, emit just the name +
    // suffix, no em-dash.
    const header = freshness
      ? `**${plan.name}** — ${freshness}${activitySuffix}`
      : `**${plan.name}**${activitySuffix}`;

    // Token-budget gate: when totalPlans > 5, only isLatest plans get
    // sub-book expansion. Others render header + COLLAPSED_HINT_SUFFIX.
    const shouldExpand = !tokenBudgetTriggered || plan.isLatest === true;

    if (!shouldExpand) {
      blocks.push(header + COLLAPSED_HINT_SUFFIX);
      deferredPlans += 1;
      continue;
    }

    const revisions = sortRevisions(revisionsByPlanId[plan.planId] ?? []);
    const supplements = sortSupplements(
      supplementsByPlanId[plan.planId] ?? [],
    );

    const hasSubBooks = revisions.length > 0 || supplements.length > 0;

    if (!hasSubBooks) {
      // Q3 silence — emit header only, no bullets, no negative-space text.
      blocks.push(header);
      // Count as "expanded" semantically since we did the lookup (no cap
      // hit), but the bullet block was correctly silent.
      expandedPlans += 1;
      continue;
    }

    const lines: string[] = [header];

    // Cap revisions at SUB_BOOK_CAP.
    const cappedRevisions = revisions.slice(0, SUB_BOOK_CAP);
    const revisionOverflow = revisions.length - cappedRevisions.length;
    for (const r of cappedRevisions) {
      lines.push(revisionBullet(r));
    }
    if (revisionOverflow > 0) {
      lines.push(`- ${OVERFLOW_BULLET(revisionOverflow)}`);
    }

    // Cap supplements at SUB_BOOK_CAP.
    const cappedSupplements = supplements.slice(0, SUB_BOOK_CAP);
    const supplementOverflow = supplements.length - cappedSupplements.length;
    for (const s of cappedSupplements) {
      lines.push(supplementBullet(s));
    }
    if (supplementOverflow > 0) {
      lines.push(`- ${OVERFLOW_BULLET(supplementOverflow)}`);
    }

    blocks.push(lines.join('\n'));
    expandedPlans += 1;
  }

  // Plan blocks separated by a single blank line. Trailing newline omitted
  // — markdown body returns clean string the LLM emits verbatim.
  return {
    renderedMarkdown: blocks.join('\n\n'),
    expandedPlans,
    deferredPlans,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Telemetry hook surface — extracted so tests can mock the Logger.
// ──────────────────────────────────────────────────────────────────────

export interface PlanCatalogTelemetryPayload {
  timestamp: string;
  userId: string;
  totalPlans: number;
  expandedPlans: number;
  deferredPlans: number;
  renderedMarkdownByteLength: number;
  fanOutLatencyMs: number;
}

export function emitTelemetry(
  payload: PlanCatalogTelemetryPayload,
  logger: Logger = orchestratorLogger,
): void {
  // STABLE label — QA-01 will grep for `TELEMETRY_LABEL` verbatim.
  logger.log(`${TELEMETRY_LABEL} ${JSON.stringify(payload)}`);
}

// ──────────────────────────────────────────────────────────────────────
// Handler entry — fan-out parallel + compose + telemetry.
//
// Reuses existing tool handlers (`listActivePlans`,
// `listDevelopmentPlanRevisions`, `listDevelopmentPlanSupplements`) so
// the query logic is NOT duplicated; this preserves the byte-identity of
// existing read paths per BE-01 §11.
// ──────────────────────────────────────────────────────────────────────

export const getPlanCatalogOverview: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  // §17.11 — role gate is the FIRST statement; no role branching elsewhere.
  assertExecutiveRole(ctx);

  const latestOnly = params.latestOnly === true;
  const includeSubBooks = params.includeSubBooks !== false; // default true

  const fanOutStart = Date.now();

  // Resolve sibling handlers lazily to avoid circular import at module-
  // load time. The handlers file imports this orchestrator at top-level;
  // this call site fires after the module graph is fully wired.
  const siblings = resolveSiblingHandlers();

  // Step 1: fetch plan list.
  const plansEnv = await siblings.listActivePlans(
    { latestOnly, limit: 50 },
    ctx,
    deps,
  );
  const plansRaw = ((plansEnv.items as unknown) ?? []) as PlanEntry[];

  // Step 2: token-budget gate. Per Rule #47, when totalPlans > 5, only
  // `isLatest === true` plans get sub-book fan-out. This is honored
  // BOTH at fan-out time (cost saving) AND at compose time (visual).
  const totalPlans = plansRaw.length;
  const tokenBudgetTriggered = totalPlans > TOKEN_BUDGET_PLAN_THRESHOLD;
  const plansForFanOut = includeSubBooks
    ? plansRaw.filter((p) =>
        tokenBudgetTriggered ? p.isLatest === true : true,
      )
    : [];

  // Step 3: parallel fan-out per plan over revisions + supplements.
  // Internal Promise.all across (plan × {revisions, supplements}) so the
  // worst case is two-query depth, not 2N.
  const subBookCalls: Promise<{
    planId: string;
    revisions: RevisionEntry[];
    supplements: SupplementEntry[];
  }>[] = plansForFanOut.map(async (plan) => {
    const [revEnv, supEnv] = await Promise.all([
      siblings.listDevelopmentPlanRevisions(
        { planId: plan.planId, limit: 50 },
        ctx,
        deps,
      ),
      siblings.listDevelopmentPlanSupplements(
        { planId: plan.planId, limit: 50 },
        ctx,
        deps,
      ),
    ]);
    return {
      planId: plan.planId,
      revisions: ((revEnv.items as unknown) ?? []) as RevisionEntry[],
      supplements: ((supEnv.items as unknown) ?? []) as SupplementEntry[],
    };
  });

  const subBookResults = await Promise.all(subBookCalls);
  const fanOutLatencyMs = Date.now() - fanOutStart;

  const revisionsByPlanId: Record<string, RevisionEntry[]> = {};
  const supplementsByPlanId: Record<string, SupplementEntry[]> = {};
  for (const r of subBookResults) {
    revisionsByPlanId[r.planId] = r.revisions;
    supplementsByPlanId[r.planId] = r.supplements;
  }

  // Step 4: compose canonical Rule #47 markdown server-side.
  const composeResult = composePlanCatalogMarkdown({
    plans: plansRaw,
    revisionsByPlanId,
    supplementsByPlanId,
  });

  const generatedAt = new Date().toISOString();
  const metadata: PlanCatalogMetadata = {
    generatedAt,
    documentVersion: '1.0',
    totalPlans,
    expandedPlans: composeResult.expandedPlans,
    deferredPlans: composeResult.deferredPlans,
  };

  // Step 5: telemetry hook (no PII — only counts + byte length + latency).
  emitTelemetry({
    timestamp: generatedAt,
    userId: ctx.userId,
    totalPlans,
    expandedPlans: composeResult.expandedPlans,
    deferredPlans: composeResult.deferredPlans,
    renderedMarkdownByteLength: Buffer.byteLength(
      composeResult.renderedMarkdown,
      'utf8',
    ),
    fanOutLatencyMs,
  });

  const envelope: PlanCatalogOverviewEnvelope = {
    plans: plansRaw,
    revisionsByPlanId,
    supplementsByPlanId,
    renderedMarkdown: composeResult.renderedMarkdown,
    metadata,
  };

  return envelope as unknown as Record<string, unknown>;
};

// Re-export the telemetry label so QA-01 / tests can assert on it
// directly without re-declaring the string.
export const PLAN_CATALOG_TELEMETRY_LABEL = TELEMETRY_LABEL;
