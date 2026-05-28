/**
 * BE-03 — Context Hand-Off: Replay Tool-Call Summary
 *
 * Helper that converts buffered same-turn tool rows into a compact
 * `<<<CTX_HINT>>>...<<<END_CTX_HINT>>>` annotation appended to the
 * assistant replay content, so the LLM can resolve discourse anaphora
 * ("เล่มนี้" / "เล่มนั้น" / "แบบนี้") against UUIDs it acknowledged in
 * a prior turn.
 *
 * CLAUDE.md references:
 *   - §17.2  — annotation is ADVISORY. It MUST NOT alter workflow,
 *              transitions, ownership, or authority.
 *   - §17.3  — annotation is built from already-persisted
 *              `ai_executive_messages` columns (`tool_calls_json`,
 *              `tool_result_json`, `tool_name`). NO new tables, NO FK
 *              into project tables.
 *   - §17.9  — the `<<<CTX_HINT>>>` envelope is a NEW delimiter pair.
 *              Any literal `<<<` inside the embedded JSON is escaped to
 *              `[<<<]` BEFORE wrapping, mirroring `wrapToolResult`.
 *              The annotation is appended to the assistant TEXT replay
 *              only — the structured tool result going to the LLM in the
 *              SAME turn (via `wrapToolResult`) is untouched.
 *   - §17.11 — no role exemption; annotation is uniform across roles.
 *   - §17.14 — annotation extracts metadata only (id, name, code,
 *              count, date). It MUST NOT include user PII or the
 *              LAO-coordination criteria registry.
 *
 * Determinism: no clocks, no random, no `Date.now()`. Field extraction
 * order is fixed per template so byte-output is reproducible.
 */
import type { AiExecutiveMessage } from '../entities/ai-executive-message.entity';

// ────────────────────────────────────────────────────────────────────
// Public budget constants. Per-row 256 bytes JSON; per-turn 768 bytes
// total annotation INCLUDING delimiters. Exported for spec coverage.
// ────────────────────────────────────────────────────────────────────

export const CTX_HINT_PER_ROW_MAX_BYTES = 256;
export const CTX_HINT_PER_TURN_MAX_BYTES = 768;

// Delimiter pair — distinct from `<<<TOOL_RESULT>>>` and
// `<<<USER_INPUT>>>` per §17.9. The OPENING delimiter must be unique
// enough that user prose containing it can be detected and escaped.
export const CTX_HINT_OPEN = '<<<CTX_HINT>>>';
export const CTX_HINT_CLOSE = '<<<END_CTX_HINT>>>';

// Fields stripped during canonical extraction. PII never leaves the
// boundary — only the metadata fields the per-tool templates request
// are read; everything else (firstname/lastname/email/phone/citizenId
// etc.) is dropped at extraction time, not redacted post-hoc.
const PII_BLOCKED_FIELDS = new Set([
  'citizenId',
  'citizen_id',
  'phone',
  'phoneNumber',
  'phone_number',
  'email',
  'firstname',
  'firstName',
  'first_name',
  'lastname',
  'lastName',
  'last_name',
  'fullname',
  'fullName',
  'full_name',
  'userName',
  'user_name',
  'username',
  'createdByName',
  'createdByFullName',
  'responsibleOfficerName',
]);

// ────────────────────────────────────────────────────────────────────
// Minimal row shape we depend on. Accepts the full
// `AiExecutiveMessage` as well as the lightweight test fixture.
// ────────────────────────────────────────────────────────────────────

export type CtxHintInputRow = Pick<
  AiExecutiveMessage,
  'role' | 'toolName' | 'toolResultJson'
>;

// ────────────────────────────────────────────────────────────────────
// Delimiter-injection defense. Any literal `<<<` inside the embedded
// payload is rewritten to `[<<<]` BEFORE the wrap so user/tool strings
// cannot spoof the envelope closing token.
// ────────────────────────────────────────────────────────────────────

function escapeDelimiters(text: string): string {
  return text.replace(/<<</g, '[<<<]');
}

// ────────────────────────────────────────────────────────────────────
// Per-tool extraction templates. Each template reads a known SAFE
// subset of fields from the tool result and returns a tiny JS object
// shaped for embedding into the CTX_HINT JSON. Returning `null` (or an
// empty array) means "no usable hint" — caller skips this tool entry.
//
// Determinism rule: each template builds its output object via an
// explicit field-by-field copy in a fixed key order. NEVER spread
// `result` or `item` — that would leak fields and break determinism.
// ────────────────────────────────────────────────────────────────────

type SummaryItem = Record<string, unknown>;

interface ToolSummary {
  tool: string;
  result: SummaryItem[] | { summary: string; meta?: SummaryItem };
}

const ITEM_CAP_LIST_TOOLS = 5;

/**
 * Safe scalar copy. Accepts string/number/boolean/null; coerces
 * anything else (objects, arrays) to null so structural PII cannot
 * sneak through a `name` field that is unexpectedly an object.
 */
function scalar(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return v as string | number | boolean;
  }
  return null;
}

/**
 * Strip-and-truncate sanitizer for free-text label fields. Caps at
 * 64 characters so a pathologically long `name` cannot blow per-row
 * budget by itself.
 */
function safeLabel(v: unknown): string | null {
  const s = scalar(v);
  if (typeof s !== 'string') return null;
  return s.length > 64 ? s.slice(0, 64) + '…' : s;
}

function getItems(result: unknown): unknown[] {
  if (!result || typeof result !== 'object') return [];
  const items = (result as Record<string, unknown>)['items'];
  return Array.isArray(items) ? items : [];
}

// Per-template builders ──────────────────────────────────────────────

function summarizeListActivePlans(result: unknown): ToolSummary | null {
  const items = getItems(result);
  if (items.length === 0) {
    return { tool: 'listActivePlans', result: [] };
  }
  const out: SummaryItem[] = [];
  for (let i = 0; i < Math.min(items.length, ITEM_CAP_LIST_TOOLS); i++) {
    const it = items[i] as Record<string, unknown>;
    out.push({
      id: scalar(it.planId ?? it.id),
      name: safeLabel(it.name),
      isLatest: scalar(it.isLatest),
      isBooked: scalar(it.isBooked),
    });
  }
  if (items.length > ITEM_CAP_LIST_TOOLS) {
    out.push({ note: `+${items.length - ITEM_CAP_LIST_TOOLS} more` });
  }
  return { tool: 'listActivePlans', result: out };
}

function summarizeListRevisions(result: unknown): ToolSummary | null {
  const items = getItems(result);
  if (items.length === 0) {
    return { tool: 'listDevelopmentPlanRevisions', result: [] };
  }
  const out: SummaryItem[] = [];
  for (let i = 0; i < Math.min(items.length, ITEM_CAP_LIST_TOOLS); i++) {
    const it = items[i] as Record<string, unknown>;
    out.push({
      id: scalar(it.revisionId ?? it.id),
      revisionNumber: scalar(it.revisionNumber),
      type: safeLabel(it.revisionTypeName ?? it.type),
      isOpen: scalar(it.isOpen),
      isBooked: scalar(it.isBooked),
    });
  }
  if (items.length > ITEM_CAP_LIST_TOOLS) {
    out.push({ note: `+${items.length - ITEM_CAP_LIST_TOOLS} more` });
  }
  return { tool: 'listDevelopmentPlanRevisions', result: out };
}

function summarizeListSupplements(result: unknown): ToolSummary | null {
  const items = getItems(result);
  if (items.length === 0) {
    return { tool: 'listDevelopmentPlanSupplements', result: [] };
  }
  const out: SummaryItem[] = [];
  for (let i = 0; i < Math.min(items.length, ITEM_CAP_LIST_TOOLS); i++) {
    const it = items[i] as Record<string, unknown>;
    out.push({
      id: scalar(it.supplementId ?? it.id),
      supplementNumber: scalar(it.supplementNumber),
      isOpen: scalar(it.isOpen),
      isBooked: scalar(it.isBooked),
    });
  }
  if (items.length > ITEM_CAP_LIST_TOOLS) {
    out.push({ note: `+${items.length - ITEM_CAP_LIST_TOOLS} more` });
  }
  return { tool: 'listDevelopmentPlanSupplements', result: out };
}

function summarizeListProjects(
  toolName: string,
  result: unknown,
): ToolSummary | null {
  const items = getItems(result);
  if (items.length === 0) {
    return { tool: toolName, result: [] };
  }
  const out: SummaryItem[] = [];
  for (let i = 0; i < Math.min(items.length, ITEM_CAP_LIST_TOOLS); i++) {
    const it = items[i] as Record<string, unknown>;
    out.push({
      id: scalar(it.projectId ?? it.id),
      title: safeLabel(it.title ?? it.projectTitle ?? it.name),
      latestStatus: safeLabel(it.latestStatus ?? it.statusName ?? it.status),
    });
  }
  if (items.length > ITEM_CAP_LIST_TOOLS) {
    out.push({ note: `+${items.length - ITEM_CAP_LIST_TOOLS} more` });
  }
  return { tool: toolName, result: out };
}

function summarizeRevisionBookSummary(result: unknown): ToolSummary | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const meta: SummaryItem = {
    id: scalar(r.revisionId),
    revisionNumber: scalar(r.revisionNumber),
    type: safeLabel(r.revisionTypeName ?? r.type),
  };
  const totalProjects = scalar(r.totalProjects ?? r.projectCount);
  const breakdown = buildStatusBreakdownSummary(r.executiveStatusBreakdown);
  return {
    tool: 'getRevisionBookSummary',
    result: {
      summary: `totalProjects=${totalProjects ?? 'n/a'}${
        breakdown ? `; ${breakdown}` : ''
      }`,
      meta,
    },
  };
}

function summarizeSupplementBookSummary(result: unknown): ToolSummary | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const meta: SummaryItem = {
    id: scalar(r.supplementId),
    supplementNumber: scalar(r.supplementNumber),
  };
  const totalProjects = scalar(r.totalProjects ?? r.projectCount);
  const breakdown = buildStatusBreakdownSummary(r.executiveStatusBreakdown);
  return {
    tool: 'getSupplementBookSummary',
    result: {
      summary: `totalProjects=${totalProjects ?? 'n/a'}${
        breakdown ? `; ${breakdown}` : ''
      }`,
      meta,
    },
  };
}

function buildStatusBreakdownSummary(breakdown: unknown): string | null {
  if (!breakdown || typeof breakdown !== 'object') return null;
  const b = breakdown as Record<string, unknown>;
  // Deterministic key order — the §15 executive group definition is
  // pending_review / awaiting_approval / approved / rejected. Other
  // shapes (per-status counts) are coerced to a stable key sort.
  const knownKeys = ['pending_review', 'awaiting_approval', 'approved', 'rejected'];
  const present = knownKeys.filter((k) => k in b);
  if (present.length === 0) {
    // Generic fallback — sort keys alphabetically for determinism.
    const allKeys = Object.keys(b).sort();
    if (allKeys.length === 0) return null;
    return allKeys
      .map((k) => `${k}=${String(scalar(b[k]) ?? 0)}`)
      .join(',');
  }
  return present.map((k) => `${k}=${String(scalar(b[k]) ?? 0)}`).join(',');
}

// ────────────────────────────────────────────────────────────────────
// Template registry. Tools not listed → return null (no annotation
// produced for that tool). This prevents indiscriminate field leakage
// and keeps the budget tight.
// ────────────────────────────────────────────────────────────────────

function summarizeForTool(
  toolName: string | null,
  result: unknown,
): ToolSummary | null {
  if (!toolName) return null;
  switch (toolName) {
    case 'listActivePlans':
      return summarizeListActivePlans(result);
    case 'listDevelopmentPlans':
      // Alias the BE-02 catalog name to the same shape as listActivePlans.
      return summarizeListActivePlans(result);
    case 'listDevelopmentPlanRevisions':
      return summarizeListRevisions(result);
    case 'listDevelopmentPlanSupplements':
      return summarizeListSupplements(result);
    case 'listProjectsInPlan':
    case 'listProjectsInRevisionBook':
    case 'listProjectsInSupplementBook':
      return summarizeListProjects(toolName, result);
    case 'getRevisionBookSummary':
      return summarizeRevisionBookSummary(result);
    case 'getSupplementBookSummary':
      return summarizeSupplementBookSummary(result);
    default:
      return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// Defense-in-depth PII strip. Even though each template explicitly
// copies a known field allow-list, a stray nested object that slipped
// through `scalar()` would surface here. This walker drops any key in
// PII_BLOCKED_FIELDS at any nesting level. PURE — never mutates input.
// ────────────────────────────────────────────────────────────────────

function stripPii(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripPii);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (PII_BLOCKED_FIELDS.has(k)) continue;
      out[k] = stripPii(v);
    }
    return out;
  }
  return value;
}

// ────────────────────────────────────────────────────────────────────
// Per-row truncation. If a single tool summary serializes to more than
// `CTX_HINT_PER_ROW_MAX_BYTES` bytes, truncate by dropping items from
// the END of the result array (preserving the first item which carries
// the most context-resolution value for anaphora — the FIRST entity
// the user just saw is the one they're most likely referring to).
// ────────────────────────────────────────────────────────────────────

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function truncateSummary(summary: ToolSummary): string | null {
  const cleaned = stripPii(summary) as ToolSummary;
  let serialized = JSON.stringify(cleaned);
  if (byteLength(serialized) <= CTX_HINT_PER_ROW_MAX_BYTES) {
    return serialized;
  }
  // Result is an array? Drop items from the tail until it fits.
  if (Array.isArray((cleaned as { result: unknown }).result)) {
    const arr = (cleaned as { result: SummaryItem[] }).result;
    while (arr.length > 0) {
      arr.pop();
      const candidate: ToolSummary = {
        tool: cleaned.tool,
        result: arr.length > 0 ? [...arr, { note: 'truncated' }] : [],
      };
      serialized = JSON.stringify(candidate);
      if (byteLength(serialized) <= CTX_HINT_PER_ROW_MAX_BYTES) {
        return serialized;
      }
    }
    return null;
  }
  // Object-shape result (summary tool). Drop the meta block first.
  if (
    typeof (cleaned as { result: unknown }).result === 'object' &&
    (cleaned as { result: Record<string, unknown> }).result !== null
  ) {
    const obj = (cleaned as { result: Record<string, unknown> }).result;
    if ('meta' in obj) {
      delete obj.meta;
      serialized = JSON.stringify(cleaned);
      if (byteLength(serialized) <= CTX_HINT_PER_ROW_MAX_BYTES) {
        return serialized;
      }
    }
    // Still too big — drop summary too.
    return null;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────
// Public: build the CTX hint annotation for an assistant turn given
// the same-turn tool rows that preceded it. Returns `null` when:
//   - no tool rows
//   - every tool row's summary template returns null (unsupported)
//   - every tool row would push the annotation over per-turn budget
//
// The caller appends the returned string to the assistant content with
// a `\n\n` separator.
// ────────────────────────────────────────────────────────────────────

export function buildContextHint(toolRows: CtxHintInputRow[]): string | null {
  if (!Array.isArray(toolRows) || toolRows.length === 0) return null;

  const lines: string[] = [];
  let runningBytes = byteLength(CTX_HINT_OPEN) + byteLength(CTX_HINT_CLOSE) + 2; // 2 = newlines around content

  for (const row of toolRows) {
    if (row.role !== 'tool') continue;
    if (!row.toolName) continue;
    const summary = summarizeForTool(row.toolName, row.toolResultJson);
    if (!summary) continue;

    const serialized = truncateSummary(summary);
    if (!serialized) continue;

    // Delimiter escape AFTER serialization, BEFORE budget check.
    const escaped = escapeDelimiters(serialized);
    const lineBytes = byteLength(escaped) + 1; // +1 for newline separator
    if (runningBytes + lineBytes > CTX_HINT_PER_TURN_MAX_BYTES) {
      // Per-turn cap exceeded — DROP this line. We continue checking
      // subsequent lines in case they are smaller; spec says "if
      // exceeded, DROP entire annotation" only when the FIRST line
      // already busts budget. Multi-line: include what fits, drop rest.
      // Conservative interpretation: stop here so output is monotone.
      break;
    }
    runningBytes += lineBytes;
    lines.push(escaped);
  }

  if (lines.length === 0) return null;

  return `${CTX_HINT_OPEN}\n${lines.join('\n')}\n${CTX_HINT_CLOSE}`;
}

// ────────────────────────────────────────────────────────────────────
// Test-only exports. Kept underscored so consumers know not to depend
// on them; the spec imports them via the `__test__` re-export pattern.
// ────────────────────────────────────────────────────────────────────

export const _internal = {
  escapeDelimiters,
  scalar,
  safeLabel,
  stripPii,
  summarizeForTool,
  truncateSummary,
  byteLength,
};
