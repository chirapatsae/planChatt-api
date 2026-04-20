import { Injectable, Logger } from '@nestjs/common';
import {
  CriterionHint,
  IssueCriterion,
  IssueRuleEntry,
} from './issue-criteria.types';

/**
 * Attachment summary shape consumed by the evidence pre-check. A
 * superset of every relevant attachment entity (`AttachmentProjectGroup`,
 * `AttachmentRevisedProjectGroup`, `AttachmentSupplementProjectGroup`)
 * kept deliberately loose — the evidence check only needs the OCR
 * artefacts (`aiTopic`, `aiSummary`) and a stable id for evidenceLink.
 *
 * Passed in by the AI service caller; never loaded here. This keeps
 * the service pure and avoids a cross-domain repository dependency.
 */
export interface EvidenceAttachmentInput {
  id: string;
  aiTopic?: string | null;
  aiSummary?: string | null;
  /**
   * Optional pre-built app-relative link (e.g. `/api/v1/attachment-project-groups/:id`).
   * Callers that do not compute links may omit this — the hint will
   * then set `evidenceLink: null` and the UI will render a plain chip.
   * Raw S3 / presigned URLs MUST NOT be passed here (§17.9).
   */
  evidenceLink?: string | null;
}

/**
 * Keyword map for the Wave 24 `evidenceTags` whitelist.
 *
 * Source: `docs/architecture/ISSUE_BASED_CRITERIA.md` §8.
 *
 * Wave 24 uses substring (case-insensitive on NFC-normalized Thai)
 * matching only. Semantic embedding search is a Wave 25 follow-up.
 */
const TAG_KEYWORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'land-use-permit': ['ขออนุญาตใช้พื้นที่', 'หนังสืออนุญาต', 'ใบอนุญาต'],
  'forest-clearance': ['ป่าสงวน', 'ขออนุญาตเข้าทำประโยชน์', 'อุทยาน'],
  'ministry-letter': ['หนังสือกระทรวง', 'บันทึกข้อตกลง'],
});

/**
 * Wave 24 N4 — deterministic evidence pre-check.
 *
 * Source of truth: `docs/architecture/ISSUE_BASED_CRITERIA.md` §8.
 *
 * For every criterion with `evidenceRequired:true` the service scans
 * OCR summaries on attached documents for keyword hits from the
 * criterion's `evidenceTags`. A hit yields `suggestedVerdict:'pass'`
 * (soft precedence — `hardOverride:false`) and surfaces the first
 * matching attachment id via `evidenceLink`. A miss yields
 * `suggestedVerdict:'needs-evidence'` (also soft — `hardOverride:false`
 * because the LLM may quote attachment body text the OCR layer missed).
 *
 * Advisory-only per §17.2. No workflow gating; `evidenceLink` stays
 * app-relative or null per §17.9 (never a raw S3 / presigned URL).
 */
@Injectable()
export class IssueCriteriaEvidenceCheckService {
  private readonly logger = new Logger(IssueCriteriaEvidenceCheckService.name);

  evaluate(
    entry: IssueRuleEntry,
    attachments: EvidenceAttachmentInput[],
  ): CriterionHint[] {
    const hints: CriterionHint[] = [];
    const evidenceCriteria = entry.criteria.filter(
      (c) => c.evidenceRequired && Array.isArray(c.evidenceTags) && c.evidenceTags.length > 0,
    );
    if (evidenceCriteria.length === 0) return hints;

    // Precompute the normalized OCR haystack per attachment. NFC
    // normalization avoids false negatives from NFD input-method text.
    const haystacks = (attachments ?? []).map((a) => {
      const raw = `${a.aiTopic ?? ''}\n${a.aiSummary ?? ''}`.trim();
      return {
        attachment: a,
        text: raw ? raw.normalize('NFC').toLowerCase() : '',
      };
    });

    for (const criterion of evidenceCriteria) {
      const match = this.findMatch(criterion, haystacks);
      if (match) {
        hints.push({
          criterionId: criterion.id,
          suggestedVerdict: 'pass',
          reason: `พบเอกสารอ้างอิง (${match.tag}) จากไฟล์แนบ id=${match.attachment.id}`,
          evidenceLink: match.attachment.evidenceLink ?? null,
          kind: 'evidence-auto',
          // Architecture §8 — evidence `pass` is soft. We emit it as
          // non-hard so the LLM's rationale survives; the merger still
          // prefers evidence-auto pass over an LLM `needs-evidence`.
          hardOverride: false,
        });
      } else {
        hints.push({
          criterionId: criterion.id,
          suggestedVerdict: 'needs-evidence',
          reason:
            'ไม่พบเอกสารอ้างอิงที่ตรงกับเกณฑ์ในไฟล์แนบ (OCR keyword miss) — กรุณาแนบหลักฐาน',
          evidenceLink: null,
          kind: 'evidence-auto',
          // Soft — the LLM MAY override with quoted counter-evidence
          // it reads from the project text (architecture §8).
          hardOverride: false,
        });
      }
    }

    this.logger.debug(
      `[EvidenceCheck] issueKey=${entry.issueKey} criteria=${evidenceCriteria.length} attachments=${attachments?.length ?? 0} hints=${hints.length}`,
    );
    return hints;
  }

  private findMatch(
    criterion: IssueCriterion,
    haystacks: Array<{
      attachment: EvidenceAttachmentInput;
      text: string;
    }>,
  ): { attachment: EvidenceAttachmentInput; tag: string } | null {
    if (!criterion.evidenceTags) return null;
    for (const tag of criterion.evidenceTags) {
      const keywords = TAG_KEYWORDS[tag];
      if (!keywords || keywords.length === 0) continue;
      for (const h of haystacks) {
        if (!h.text) continue;
        for (const kw of keywords) {
          const needle = kw.normalize('NFC').toLowerCase();
          if (needle && h.text.includes(needle)) {
            return { attachment: h.attachment, tag };
          }
        }
      }
    }
    return null;
  }
}
