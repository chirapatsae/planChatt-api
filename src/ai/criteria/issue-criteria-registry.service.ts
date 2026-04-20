import { Injectable, Logger } from '@nestjs/common';
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

/**
 * IssueCriteriaRegistryService — Wave 24 N1.
 *
 * Read-only, side-effect-free lookup over the in-code criteria
 * registry. Consumed by:
 *   - GET /v1/development-issue/:id/criteria (this module)
 *   - AiService AI-generate prompt injection (N3)
 *   - AiService pre-submit review prompt injection (N4)
 *
 * Design notes:
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
}
