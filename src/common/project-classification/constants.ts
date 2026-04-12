/**
 * Frozen Thai copy for the Multi-Format Reporting feature (CLAUDE.md §16).
 *
 * Single source of truth for user-facing strings produced by the backend
 * layer. JSX/service code MUST import from this module rather than
 * hardcoding Thai strings — doing otherwise breaks the copy-freeze
 * contract and makes wording updates risky.
 *
 * Error prefixes match the contract consumed by
 * `frontend/src/api/axios.tsx` and the FE toast mapping in
 * `frontend/src/components/multiFormatReporting/constants.ts`.
 */

// ──────────────────────────────────────────────────────────────────────
// Canonical error codes
// ──────────────────────────────────────────────────────────────────────

export const ERROR_CODES = {
  /** §16.4 — reportFormat cannot change after plan creation. */
  REPORT_FORMAT_IMMUTABLE: 'REPORT_FORMAT_IMMUTABLE',
  /** §16.5 — classification shape invariant violated. */
  PROJECT_CLASSIFICATION_SHAPE_MISMATCH:
    'PROJECT_CLASSIFICATION_SHAPE_MISMATCH',
  /** §16.6 — issue soft-delete blocked by referencing project. */
  DEVELOPMENT_ISSUE_IN_USE: 'DEVELOPMENT_ISSUE_IN_USE',
  /** §16.6 — issue not found on the given plan. */
  DEVELOPMENT_ISSUE_NOT_FOUND: 'DEVELOPMENT_ISSUE_NOT_FOUND',
  /** §16.6 — issue belongs to a different plan than the project. */
  DEVELOPMENT_ISSUE_PLAN_MISMATCH: 'DEVELOPMENT_ISSUE_PLAN_MISMATCH',
} as const;

// ──────────────────────────────────────────────────────────────────────
// Thai copy — error messages
// ──────────────────────────────────────────────────────────────────────

export const ERROR_MESSAGES = {
  REPORT_FORMAT_IMMUTABLE:
    'ไม่สามารถเปลี่ยนรูปแบบรายงานของแผนพัฒนาหลังจากสร้างแล้ว',
  PROJECT_CLASSIFICATION_SHAPE_MISMATCH:
    'ข้อมูลการจำแนกประเภทโครงการไม่ถูกต้องสำหรับรูปแบบเล่มนี้',
  STRATEGY_BASED_REQUIRES_STRATEGY:
    'แผนแบบยุทธศาสตร์ต้องระบุยุทธศาสตร์ กลยุทธ์ และแผนงาน',
  STRATEGY_BASED_REQUIRES_INDICATOR:
    'แผนแบบยุทธศาสตร์ต้องระบุตัวชี้วัด (KPI)',
  STRATEGY_BASED_FORBIDS_ISSUE:
    'แผนแบบยุทธศาสตร์ต้องไม่มีประเด็นการพัฒนา',
  ISSUE_BASED_REQUIRES_ISSUE:
    'แผนแบบประเด็นการพัฒนาต้องระบุประเด็นการพัฒนา',
  ISSUE_BASED_FORBIDS_STRATEGY:
    'แผนแบบประเด็นการพัฒนาต้องไม่มียุทธศาสตร์/กลยุทธ์/แผนงาน',
  ISSUE_BASED_FORBIDS_INDICATOR:
    'แผนแบบประเด็นการพัฒนาต้องไม่มีตัวชี้วัด (KPI)',
  DEVELOPMENT_ISSUE_IN_USE:
    'ไม่สามารถลบประเด็นการพัฒนาได้ เนื่องจากมีโครงการที่ใช้งานอยู่',
  DEVELOPMENT_ISSUE_NOT_FOUND: 'ไม่พบประเด็นการพัฒนาที่ระบุ',
  DEVELOPMENT_ISSUE_PLAN_MISMATCH:
    'ประเด็นการพัฒนาที่เลือกไม่ตรงกับแผนพัฒนาของโครงการ',
  PARENT_PLAN_NOT_FOUND: 'ไม่พบแผนพัฒนาต้นทางของโครงการ',
} as const;

// ──────────────────────────────────────────────────────────────────────
// Badge labels (echoed by frontend via its own constants file, but
// backend needs the canonical Thai strings for PDF headers and similar
// server-rendered surfaces).
// ──────────────────────────────────────────────────────────────────────

export const FORMAT_LABELS = {
  STRATEGY_BASED: 'แบบยุทธศาสตร์',
  ISSUE_BASED: 'แบบประเด็นการพัฒนา',
} as const;
