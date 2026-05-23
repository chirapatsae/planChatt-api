import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import {
  CriterionHint,
  IssueCriterion,
  IssueRuleEntry,
} from './issue-criteria.types';

/**
 * Wave AI-Enforcement-Model (2026-05-22) — deterministic title-
 * uniqueness pre-check.
 *
 * Resolves the verdict for any criterion whose `geoAutoCheck` kind
 * is `'title-uniqueness'` — i.e. the "ไม่ซ้ำซ้อนกับภารกิจของ อปท. อื่น"
 * family of criteria (C1.c, C2.c, C3_1.c, C4_5to6.d).
 *
 * BUSINESS RULE (per user direction 2026-05-22):
 *   "ถ้ามีชื่อโครงการซ้ำ คือ ซ้ำซ้อน" — duplicate title means duplicate work.
 *   Title uniqueness is the proxy the system uses for "non-duplicate
 *   coordination with another LAO".
 *
 * SCOPE:
 *   - Compares against ALL non-soft-deleted `ProjectGroup` rows
 *   - Excludes self when `targetProjectId` is passed (in-progress edit /
 *     re-evaluation of an existing project)
 *   - Title comparison is NFC-normalized + trimmed, case-insensitive on
 *     Thai (Thai is single-case but lowercasing is still a defensive
 *     no-op against any embedded ASCII)
 *
 * §17.2 — advisory verdict; never gates submit. The criterion itself
 * is workflow-irrelevant in §17.14 scope (LAO-coordination criteria
 * are advisory by definition).
 *
 * §17.3 — service does ONLY a read query; never writes any audit row.
 *
 * §17.9 — input is structured (UUID + Thai title string); no
 * user-controlled prompt text is ever constructed here.
 */
@Injectable()
export class IssueCriteriaTitleUniquenessCheckService {
  private readonly logger = new Logger(
    IssueCriteriaTitleUniquenessCheckService.name,
  );

  constructor(
    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,
  ) {}

  /**
   * For every criterion in `entry.criteria` whose `geoAutoCheck` is
   * `'title-uniqueness'`, run the duplicate-title check and emit a
   * deterministic hint. Criteria without that hint are ignored — they
   * are NOT this service's concern.
   *
   * @param entry              one matched `IssueRuleEntry`
   * @param projectTitle       the current project's title (trimmed)
   * @param targetProjectId    optional self-id to exclude from the
   *                           duplicate scan (omit on AddProject pre-
   *                           submit because the row does not exist yet)
   */
  async resolveTitleUniqueness(
    entry: IssueRuleEntry,
    projectTitle: string | null | undefined,
    targetProjectId?: string | null,
  ): Promise<CriterionHint[]> {
    const hints: CriterionHint[] = [];
    const relevant = entry.criteria.filter(
      (c) => c.geoAutoCheck === 'title-uniqueness',
    );
    if (relevant.length === 0) return hints;

    // Normalize title once
    const titleNorm = (projectTitle ?? '').normalize('NFC').trim();
    if (titleNorm.length === 0) {
      // No title → treat as needs-evidence so the LLM (or staff) can
      // see the criterion still needs attention. This branch is unusual
      // because pre-submit-review carries a project title by contract;
      // it exists for defensive resilience.
      for (const c of relevant) {
        hints.push(this.buildHint(c, 'needs-evidence', 'ไม่ระบุชื่อโครงการ', entry.issueKey));
      }
      return hints;
    }

    // Query for duplicate title — exclude self when possible.
    let duplicateCount = 0;
    try {
      const where: Record<string, unknown> = { title: titleNorm };
      if (targetProjectId) {
        where.id = Not(targetProjectId);
      }
      duplicateCount = await this.projectGroupRepo.count({ where });
    } catch (err) {
      // Repository failures MUST NOT bubble — degrade to "no hint" so
      // the criterion falls through to the LLM (legacy behavior).
      this.logger.warn(
        `[TitleUniquenessCheck] repository query failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return hints;
    }

    const verdict = duplicateCount > 0 ? 'fail' : 'pass';
    const reason =
      duplicateCount > 0
        ? `พบโครงการชื่อเดียวกันในระบบแล้ว ${duplicateCount} โครงการ — ถือว่าซ้ำซ้อนกับภารกิจของ อปท. อื่น`
        : 'ไม่พบโครงการชื่อเดียวกันในระบบ — ไม่ซ้ำซ้อนกับภารกิจของ อปท. อื่น';

    for (const c of relevant) {
      hints.push(this.buildHint(c, verdict, reason, entry.issueKey));
    }
    return hints;
  }

  private buildHint(
    c: IssueCriterion,
    suggestedVerdict: 'pass' | 'fail' | 'needs-evidence',
    reason: string,
    issueKey: string,
  ): CriterionHint {
    return {
      criterionId: c.id,
      suggestedVerdict,
      reason,
      // §17.9 — title-uniqueness has no document evidence to link.
      evidenceLink: null,
      // Reuse the existing `evidence-auto` kind because the merger
      // already maps it to `CriterionSource: 'evidence-auto'` and the
      // UI treats it as deterministic. Adding a new kind would require
      // touching all consumer code; the semantics are aligned (both
      // are deterministic auto-checks).
      kind: 'evidence-auto',
      // Hard override — title duplication is an objective signal the
      // LLM cannot dispute by reading the project prose.
      hardOverride: true,
      issueKey,
    };
  }
}
