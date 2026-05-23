import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import {
  IssueRuleEntry,
  ProvinceCode,
} from './issue-criteria.types';
import {
  NAKHON_RATCHASIMA_ISSUE_RULES,
  NAKHON_RATCHASIMA_RULESET_VERSION,
} from './nakhon-ratchasima-issue-rules';
import {
  extractEntryRoot,
  extractStrategyRoot,
  normalizeThaiPhrase,
} from './strategy-name.util';

/**
 * IssueCriteriaRegistryService — Wave 24 N1.
 *
 * Read-only, side-effect-free lookup over the in-code criteria
 * registry. Consumed by:
 *   - GET /v1/development-issue/:id/criteria (this module)
 *   - AiService AI-generate prompt injection (N3)
 *   - AiService pre-submit review prompt injection (N4)
 *
 * --- SEMANTIC SCOPE (CRITICAL) — CLAUDE.md §17.14 ---------------------
 *
 * The registry served by this service encodes **regulatory evaluation
 * criteria for projects that LAO (องค์กรปกครองส่วนท้องถิ่น) coordinates
 * with government agencies for execution**. It is NOT a generic project-
 * quality registry.
 *
 * Concretely:
 *   - province scope: NAKHON_RATCHASIMA only (Wave 24 entries)
 *   - caller scope:   LAO classification per CLAUDE.md §1 only —
 *                     Agency callers MUST NOT reach this service for
 *                     STRATEGY_BASED criteria injection (D4=B gate in
 *                     AiService is the enforcement point)
 *   - project scope:  LAO-originated main-plan projects handed off to
 *                     government agencies for execution (NOT Revision /
 *                     Change / Supplement / Agency-direct)
 *
 * Future expansion to other province or to agency-originated projects
 * MUST add a separate registry data file (e.g. `agency-coordination-
 * rules.ts`) — never extend `nakhon-ratchasima-issue-rules.ts` with
 * cross-scope entries. See CLAUDE.md §17.14.3 for the canonical
 * expansion path.
 *
 * The boundary is enforced at three layers (caller gate / registry
 * data shape / score adjustment) — see CLAUDE.md §17.14.1.
 *
 * --- Design notes ----------------------------------------------------
 *
 *   - Matching is case-sensitive on NFC-normalized strings. Thai text
 *     normalization matters because OSes and input methods emit NFC
 *     vs NFD forms interchangeably.
 *   - `findByIssueId` accepts an optional `EntityManager` so transactional
 *     callers (N4 pre-submit review) can share the caller's snapshot
 *     and not open a second connection.
 *   - `provinceCode` is plumbed through every signature for Wave 25
 *     multi-province expansion (architecture §10). At Wave 24 it
 *     defaults to `NAKHON_RATCHASIMA`.
 *
 * Advisory-only per CLAUDE.md §17.2 — returned entries MUST NOT be
 * used as a workflow gate. The only mutation is persisting the
 * `rulesetVersion` stamp inside snapshot payloads.
 */
@Injectable()
export class IssueCriteriaRegistryService {
  private readonly logger = new Logger(IssueCriteriaRegistryService.name);

  /**
   * Province -> entries. Frozen at module load. Keep the index O(n)
   * over a tiny constant (6 entries in Wave 24); no regex compilation
   * per call.
   */
  private readonly provinceIndex: ReadonlyMap<ProvinceCode, IssueRuleEntry[]> =
    new Map<ProvinceCode, IssueRuleEntry[]>([
      ['NAKHON_RATCHASIMA', NAKHON_RATCHASIMA_ISSUE_RULES],
    ]);

  constructor(
    @InjectRepository(DevelopmentIssue)
    private readonly developmentIssueRepository: Repository<DevelopmentIssue>,
  ) {}

  /**
   * Returns the ruleset version label for the requested province. Used
   * by snapshot persistence to stamp `result.categories.criteriaEvaluation.rulesetVersion`.
   */
  getCurrentRulesetVersion(
    provinceCode: ProvinceCode = 'NAKHON_RATCHASIMA',
  ): string {
    // Wave 24: single province. When Wave 25 adds more, each province
    // file will export its own version constant and we can map here.
    if (provinceCode === 'NAKHON_RATCHASIMA') {
      return NAKHON_RATCHASIMA_RULESET_VERSION;
    }
    return NAKHON_RATCHASIMA_RULESET_VERSION;
  }

  /**
   * Lists every registry entry for a province. Used by admin /
   * diagnostic surfaces. Returns an empty array for unknown provinces
   * so callers can safely map without guarding (see architecture §10).
   */
  listAllForProvince(
    provinceCode: ProvinceCode = 'NAKHON_RATCHASIMA',
  ): IssueRuleEntry[] {
    return this.provinceIndex.get(provinceCode) ?? [];
  }

  /**
   * Primary matcher. Resolves a free-text `DevelopmentIssue.name` to
   * the canonical registry entry.
   *
   * Strategy (architecture §3):
   *   1. NFC-normalize + trim the incoming name
   *   2. Exact match against `matchers.exactNames` (also normalized)
   *   3. Fallback: substring-contains against `matchers.keywordContains`
   *   4. Return `null` when nothing matches — callers treat this as
   *      "no criteria configured; fall back to generic prompt".
   *
   * Wave 25 follow-up: fuzzy Thai match (Levenshtein / phonetic).
   */
  findByIssueName(
    issueName: string | null | undefined,
    provinceCode: ProvinceCode = 'NAKHON_RATCHASIMA',
  ): IssueRuleEntry | null {
    if (!issueName) return null;
    const entries = this.provinceIndex.get(provinceCode);
    if (!entries || entries.length === 0) return null;

    const normalized = issueName.normalize('NFC').trim();
    if (!normalized) return null;

    // Pass 1 — exact match
    for (const entry of entries) {
      for (const exact of entry.matchers.exactNames) {
        if (exact.normalize('NFC').trim() === normalized) {
          return entry;
        }
      }
    }

    // Pass 2 — keyword substring fallback
    for (const entry of entries) {
      for (const keyword of entry.matchers.keywordContains) {
        const kNorm = keyword.normalize('NFC').trim();
        if (kNorm.length > 0 && normalized.includes(kNorm)) {
          return entry;
        }
      }
    }

    return null;
  }

  /**
   * Loads the plan-scoped `DevelopmentIssue` row by id and delegates
   * to `findByIssueName`. Returns `null` when either the row is
   * missing (or soft-deleted) or the name does not match any entry.
   *
   * Accepts an optional `EntityManager` so transactional callers
   * (e.g. AI pre-submit review in N4) can share the caller's
   * snapshot / transaction.
   */
  async findByIssueId(
    issueId: string,
    provinceCode: ProvinceCode = 'NAKHON_RATCHASIMA',
    manager?: EntityManager,
  ): Promise<{
    issue: DevelopmentIssue | null;
    entry: IssueRuleEntry | null;
  }> {
    if (!issueId) return { issue: null, entry: null };

    const repo = manager
      ? manager.getRepository(DevelopmentIssue)
      : this.developmentIssueRepository;

    const issue = await repo.findOne({
      where: { id: issueId },
      relations: ['developmentPlan'],
    });

    if (!issue) {
      return { issue: null, entry: null };
    }

    const entry = this.findByIssueName(issue.name, provinceCode);
    return { issue, entry };
  }

  /**
   * STRATEGY_BASED resolver (Wave LAO issue/strategy parity).
   *
   * Resolves a `Strategy.name` to the ARRAY of registry entries whose
   * `issueDisplayName` root matches the Strategy's root after Thai
   * normalization. A single Strategy MAY map to multiple entries
   * (1-to-many) because one umbrella can host several sub-issues
   * (e.g. STRAT003 "ด้านการพัฒนาเศรษฐกิจ" → economic-3-1 + economic-3-2).
   *
   * Algorithm (see AUDIT-VERDICT §7.4 — frozen):
   *   1. `extractStrategyRoot` strips "ยุทธศาสตร์" prefix
   *   2. `normalizeThaiPhrase` NFC + collapse spelling variations
   *   3. For each registry entry: take `extractEntryRoot` (text before
   *      first " — ") and normalize the same way
   *   4. Match by EXACT equality of normalized roots (no substring)
   *   5. Return ALL matching entries (array, possibly empty)
   *
   * Contract:
   *   - empty / nullish input → throws `BadRequestException`
   *   - well-formed input with no match → returns `[]` (never throws)
   *
   * Advisory-only per CLAUDE.md §17.2 — return value drives an
   * advisory UI panel; it MUST NOT gate any workflow transition.
   * Pure compute — no DB call.
   */
  findAllByStrategyName(
    name: string,
    provinceCode: ProvinceCode = 'NAKHON_RATCHASIMA',
  ): IssueRuleEntry[] {
    if (!name || !name.trim()) {
      throw new BadRequestException('STRATEGY_NAME_REQUIRED');
    }

    const strategyRoot = normalizeThaiPhrase(extractStrategyRoot(name));
    if (!strategyRoot) {
      return [];
    }

    const entries = this.provinceIndex.get(provinceCode);
    if (!entries || entries.length === 0) return [];

    return entries.filter((entry) => {
      const entryRoot = normalizeThaiPhrase(
        extractEntryRoot(entry.issueDisplayName),
      );
      return entryRoot === strategyRoot;
    });
  }

  /**
   * Filter a set of registry entries down to those whose sub-types
   * include `subTypeCode`. Used by `AiService` AFTER `findAllByStrategyName`
   * to narrow the criteria-injection scope to the exact sub-domain the
   * user clicked (e.g. "เกษตร" → 3.1.1 → economic-3-1 only, drop
   * economic-3-2).
   *
   * Wave Sub-Type Filter (2026-05-22) — fixes the bug where STRATEGY_BASED
   * LAO Strategy "ด้านพัฒนาเศรษฐกิจ" injected BOTH economic-3-1 and
   * economic-3-2 criteria onto a farming project, causing the irrelevant
   * economic-3-2 (industry/water) checks to score the project at 0/5 and
   * suggest documents the user had no reason to attach.
   *
   * Match policy (CLAUDE.md §17.14 boundary preserved):
   *   - empty / nullish `subTypeCode`  → return `[]` ("general check"
   *     mode — Reviewer falls back to generic rubric; no per-criterion
   *     evaluation). Per user design decision 2026-05-22, the prior
   *     behaviour of "inject every entry" was found to be incorrect — if
   *     the user has not disambiguated, AI MUST NOT presume.
   *   - exact match against `entry.subTypes[].code`  → return entries
   *     containing that code (typically one entry, since codes are
   *     unique across the Nakhon Ratchasima registry; multiple is
   *     accepted defensively if a future registry duplicates a code)
   *   - non-empty but unknown code  → return `[]` (defensive — do not
   *     guess which entry the user meant)
   *
   * Inputs are caller-supplied registry entries — typically the output
   * of `findAllByStrategyName`. The helper is pure compute, no I/O.
   *
   * §17.2 advisory-only — return value drives criteria injection; never
   * gates a workflow transition.
   */
  filterEntriesBySubType(
    entries: IssueRuleEntry[],
    subTypeCode: string | null | undefined,
  ): IssueRuleEntry[] {
    // Empty / nullish → "general check" mode. Caller treats this as
    // "no criteria injection"; the Reviewer falls back to the generic
    // scoring rubric. This is the AUTHORITATIVE behaviour after the
    // 2026-05-22 design pivot — do not "default to all entries".
    if (subTypeCode === null || subTypeCode === undefined) return [];
    const trimmed = String(subTypeCode).trim();
    if (trimmed.length === 0) return [];

    // Exact code match within entry.subTypes[]. Defensive against the
    // (currently theoretical) case where a code appears in multiple
    // entries — we return all matches; the Reviewer treats this as
    // multi-entry composition under the same Strategy.
    const matched = entries.filter((entry) =>
      entry.subTypes.some((subType) => subType.code === trimmed),
    );

    // No match → return [] (defensive). Do NOT fall back to "all entries"
    // because that re-introduces the original bug. The user has either
    // (a) sent a stale code from a different strategy → drop it, or
    // (b) sent garbage → drop it. Either way, fall through to general
    // check mode rather than evaluate against unrelated criteria.
    return matched;
  }
}
