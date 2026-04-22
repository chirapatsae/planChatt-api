/**
 * Wave 36 N2 — Thai summary composer for `ai_usage_logs.summary_th`.
 *
 * Called at log-write time to produce a short, human-readable Thai
 * summary per AI endpoint. The value is persisted directly into
 * `ai_usage_logs.summary_th` so the admin detail view can render a
 * one-line description without inspecting the JSON payloads.
 *
 * §17.9 compliance: composed strings are server-derived; they MUST NOT
 * embed any user-authored prose (e.g. `userPrompt`, `additionalContext`,
 * `justification`). Callers MAY pass BE-resolved values such as the
 * parsed project `title`, `fieldName`, or deterministic admin-boundary
 * names — those are derived from structured data and are safe.
 *
 * Keep labels short (≤ 80 chars ideal). `clamp()` enforces a per-field
 * max of 50 chars with an ellipsis suffix.
 */

export type SummaryEndpoint =
  | 'generate-project-detail'
  | 'regenerate-one-field'
  | 'pre-submit-review'
  | 'land-use-classify'
  | 'document-summary'
  | 'staff-review/analyze';

export interface SummaryContext {
  endpoint: SummaryEndpoint;
  title?: string;
  fieldName?: string; // for regen endpoint
  tambonName?: string; // for classifier
  amphoeName?: string; // for classifier
  reportFormat?: string;
  // Wave 37 N2 — document-summary context. `attachmentFileName` is the
  // server-held original filename (no user prose); safe to include per
  // §17.9. `fileName` alias is accepted for call-site convenience.
  attachmentFileName?: string;
  fileName?: string;
}

const clamp = (s: string, max = 50): string =>
  s.length <= max ? s : s.slice(0, max) + '…';

export function composeSummaryTh(ctx: SummaryContext): string {
  switch (ctx.endpoint) {
    case 'generate-project-detail':
      return ctx.title
        ? `สร้างรายละเอียดโครงการ: ${clamp(ctx.title)}`
        : 'สร้างรายละเอียดโครงการ';
    case 'regenerate-one-field': {
      const field = ctx.fieldName ? ` (${ctx.fieldName})` : '';
      return ctx.title
        ? `สร้างใหม่เฉพาะฟิลด์${field}: ${clamp(ctx.title)}`
        : `สร้างใหม่เฉพาะฟิลด์${field}`;
    }
    case 'pre-submit-review':
      return ctx.title
        ? `ตรวจสอบโครงการก่อนส่ง: ${clamp(ctx.title)}`
        : 'ตรวจสอบโครงการก่อนส่ง';
    case 'land-use-classify': {
      const parts = [ctx.tambonName, ctx.amphoeName]
        .filter((s): s is string => Boolean(s))
        .join(' · ');
      return parts
        ? `จำแนกประเภทพื้นที่: ${parts}`
        : 'จำแนกประเภทพื้นที่';
    }
    case 'document-summary': {
      const name = ctx.attachmentFileName ?? ctx.fileName;
      return name
        ? `สรุปเอกสาร: ${clamp(name)}`
        : 'สรุปเอกสาร: ไฟล์แนบ';
    }
    case 'staff-review/analyze':
      return ctx.title
        ? `ตรวจสอบโครงการโดยเจ้าหน้าที่ด้วย AI: ${clamp(ctx.title)}`
        : 'ตรวจสอบโครงการโดยเจ้าหน้าที่ด้วย AI';
    default:
      return 'การเรียกใช้ AI';
  }
}
