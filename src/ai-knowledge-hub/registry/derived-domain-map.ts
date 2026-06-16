import { ExecutiveToolName } from 'src/ai-executive-chat/tools/executive-tool.types';

/**
 * Wave wave-ai-knowledge-hub — BE-01 (2026-06-12).
 *
 * Derived-domain map — the SEPARATE data file (§17.14.3 / §17.15.2(a))
 * projecting the frozen `EXECUTIVE_TOOL_REGISTRY` onto the 7 knowledge
 * domains of the executive mind-map (architecture report §1.2). The
 * registry file `ai-executive-chat/tools/tool-registry.ts` is NOT
 * modified for mapping purposes — this file is the single mapping
 * source of truth, and `__tests__/derived-domain-map.spec.ts` is the
 * drift detector: every `toolNames` entry MUST exist in
 * `EXECUTIVE_TOOL_NAMES`, and every registered tool MUST appear in
 * EXACTLY one domain. A future tool wave that forgets to extend this
 * map fails that spec loudly instead of silently dropping the tool
 * from the mind-map.
 *
 * CLAUDE.md references:
 *   - §17.15.2(a) — derived layer is read-only registry projection.
 *   - §17.14.3 — declare-scope-first separate-data-file pattern.
 *   - §17.2 — the map is advisory display data; it gates nothing.
 *
 * Type safety: `toolNames` is typed `readonly ExecutiveToolName[]`, so
 * an unknown / misspelled tool name is a COMPILE error; the runtime
 * spec covers the inverse direction (registry tool missing from the
 * map) plus duplicate-mapping.
 */

export type KnowledgeDomainLayer = 'derived' | 'curated';

export interface KnowledgeDomainDescriptor {
  /** Stable key persisted in `ai_knowledge_entries.domain_key`. */
  key: string;
  labelTh: string;
  labelEn: string;
  layer: KnowledgeDomainLayer;
  /** Registry tools backing this domain (empty for curated domains). */
  toolNames: readonly ExecutiveToolName[];
}

export interface KnowledgeCoverageGap {
  key: string;
  labelTh: string;
  reason: string;
}

/**
 * Q2 LOCKED (2026-06-12): curated-knowledge authors are admin +
 * super-admin ONLY. Surfaced verbatim on every map domain node as
 * `editableBy` so FE-01 renders the who-can-edit line without
 * inventing role copy.
 */
export const KNOWLEDGE_DOMAIN_EDITABLE_BY = [
  'admin',
  'super-admin',
] as const;

/**
 * The 7 derived domains (report §1.2 — locked table) + the BE-04
 * `knowledge-hub` meta-domain (2026-06-12 — backs the
 * `searchKnowledgeBase` tool so the registry ⇄ map bijection holds for
 * the 30-tool registry). All registry tools are partitioned across
 * these descriptors; the partition is spec-enforced (bijection) in
 * `derived-domain-map.spec.ts`.
 */
export const KNOWLEDGE_DOMAINS: readonly KnowledgeDomainDescriptor[] = [
  {
    key: 'books-plans',
    labelTh: 'เล่มแผนพัฒนา',
    labelEn: 'Books / Plans',
    layer: 'derived',
    toolNames: [
      'listActivePlans',
      'getPlanCatalogOverview',
      'getPlanOverview',
      'listDevelopmentPlanRevisions',
      'listDevelopmentPlanSupplements',
      'getRevisionBookSummary',
      'getSupplementBookSummary',
    ],
  },
  {
    key: 'projects',
    labelTh: 'โครงการ (เล่มหลัก/แก้ไข/เพิ่มเติม)',
    labelEn: 'Projects',
    layer: 'derived',
    toolNames: [
      'listProjectsInPlan',
      'listProjectsInRevisionBook',
      'listProjectsInSupplementBook',
      'searchProjectsByKeyword',
      'getProjectLineage',
      'getProjectHeadBook',
    ],
  },
  {
    key: 'workflow-status',
    labelTh: 'สถานะ/ขั้นตอนอนุมัติ',
    labelEn: 'Workflow status',
    layer: 'derived',
    toolNames: [
      'getProjectStatusBreakdown',
      'getPendingCountsByScope',
      'getApprovalPipelineSnapshot',
      'detectWorkflowAgingProjects',
    ],
  },
  {
    key: 'budget',
    labelTh: 'งบประมาณ',
    labelEn: 'Budget',
    layer: 'derived',
    toolNames: ['getBudgetSummaryByPlan', 'highlightBudgetOutliers'],
  },
  {
    key: 'agencies-geography',
    labelTh: 'ส่วนราชการ & พื้นที่',
    labelEn: 'Agencies & Geography',
    layer: 'derived',
    toolNames: [
      'getTeamWorkloadSummary',
      'listProjectsWithoutResponsibleAgency',
      'listAmphoes',
      'listLaos',
      'listAgencies',
      'getProjectLocationBreakdown',
    ],
  },
  {
    key: 'classification',
    labelTh: 'ยุทธศาสตร์/ประเด็นการพัฒนา',
    labelEn: 'Classification',
    layer: 'derived',
    toolNames: ['getProjectClassificationBreakdown', 'getDevelopmentIssues'],
  },
  {
    key: 'cross-plan-analytics',
    labelTh: 'วิเคราะห์ข้ามเล่ม',
    labelEn: 'Cross-plan analytics',
    layer: 'derived',
    toolNames: ['getExecutiveDashboardSnapshot', 'getCrossPlanInsights'],
  },
  // Wave AI-Knowledge-Hub BE-04 (2026-06-12) — meta-domain backing the
  // `searchKnowledgeBase` consumption tool (task §7: "searchKnowledgeBase
  // maps to a domain (or a dedicated `knowledge` meta-domain) —
  // bijection still holds"). The tool reads `ai_knowledge_entries`
  // (published-only per §17.15.4), not project tables, so it belongs to
  // its own retrieval node rather than any of the 7 report-§1.2 derived
  // domains. Curated entries MAY also attach to this key via
  // `domain_key` like any other domain.
  {
    key: 'knowledge-hub',
    labelTh: 'องค์ความรู้ (Knowledge Hub)',
    labelEn: 'Knowledge Hub',
    layer: 'derived',
    toolNames: ['searchKnowledgeBase'],
  },
] as const;

/**
 * Curated-only domains (§17.15.2(b) — report §2.2 category list:
 * glossary / org facts / policy notes / FAQ). These are knowledge
 * homes the live DB cannot derive; they carry no backing tools.
 * Curated entries MAY also attach to any derived domain key above —
 * BE-02 validates `domain_key` against `ALL_KNOWLEDGE_DOMAIN_KEYS`.
 */
export const CURATED_DOMAINS: readonly KnowledgeDomainDescriptor[] = [
  {
    key: 'glossary',
    labelTh: 'อภิธานศัพท์ระบบ',
    labelEn: 'Glossary',
    layer: 'curated',
    toolNames: [],
  },
  {
    key: 'org-facts',
    labelTh: 'ข้อมูลองค์กร',
    labelEn: 'Organization facts',
    layer: 'curated',
    toolNames: [],
  },
  {
    key: 'policy-notes',
    labelTh: 'นโยบาย/แนวปฏิบัติ',
    labelEn: 'Policy notes',
    layer: 'curated',
    toolNames: [],
  },
  {
    key: 'faq',
    labelTh: 'คำถามที่พบบ่อย',
    labelEn: 'FAQ',
    layer: 'curated',
    toolNames: [],
  },
] as const;

/** Curated-only domain keys (convenience projection of the above). */
export const CURATED_DOMAIN_KEYS: readonly string[] = CURATED_DOMAINS.map(
  (domain) => domain.key,
);

/**
 * Derived (tool-backed) domain keys — the ONLY keys a tool may bind to.
 * Curated domains carry NO backing tools (above), so the Phase-3 tool-
 * binding override (BE-04) validates `:domainKey` against THIS set: a
 * `PUT /structure/tool-bindings/:domainKey` for a curated / unknown key
 * is rejected before any bijection check (§17.16.5). Convenience
 * projection — the bijection backstop still lives in
 * `derived-domain-map.spec.ts`.
 */
export const DERIVED_DOMAIN_KEYS: readonly string[] = KNOWLEDGE_DOMAINS.map(
  (domain) => domain.key,
);

/**
 * Every key a knowledge entry may carry in `domain_key` (derived +
 * curated). BE-02 rejects anything else with
 * `400 KNOWLEDGE_DOMAIN_UNKNOWN`.
 */
export const ALL_KNOWLEDGE_DOMAIN_KEYS: readonly string[] = [
  ...KNOWLEDGE_DOMAINS,
  ...CURATED_DOMAINS,
].map((domain) => domain.key);

/**
 * Q1 LOCKED (2026-06-12): equipment (ครุภัณฑ์) has ZERO executive-chat
 * tools — EPG / RELPG / SEPG are invisible to the chat (§17.15.1,
 * report §1.3 FINDING). The mind-map renders this honestly as a muted
 * coverage-gap node; this wave ships NO equipment tools. Closing the
 * gap is a separate wave with its own clause note.
 */
export const COVERAGE_GAPS: readonly KnowledgeCoverageGap[] = [
  {
    key: 'equipment',
    labelTh: 'ครุภัณฑ์',
    reason: 'no executive tool registered',
  },
] as const;
