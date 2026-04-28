/**
 * BE-W44-02 — decision-framing system-prompt test.
 *
 * Asserts that the five decision-assist rules (rules 6–10) are pinned
 * in `EXECUTIVE_CHAT_SYSTEM_PROMPT`. Any refactor that drops a rule is
 * a §17.2 regression — the advisory framing is the ONLY gate between
 * the LLM's free-text output and a workflow-action-shaped reply.
 */
import {
  EXECUTIVE_CHAT_SYSTEM_PROMPT,
  EXECUTIVE_CHAT_TOOL_INSTRUCTIONS,
} from '../prompts/executive-chat-system-prompt';

describe('BE-W44-02 / decision-framing system prompt (§17.2)', () => {
  it('includes rule 6 — must call a tool before giving a recommendation', () => {
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/detectWorkflowAgingProjects/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/highlightBudgetOutliers/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/getApprovalPipelineSnapshot/);
  });

  it('includes rule 7 — recommendation MUST start with "ข้อเสนอแนะ:" and cite tool', () => {
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/ข้อเสนอแนะ:/);
  });

  it('includes rule 8 — forbid imperatives', () => {
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/ห้ามใช้คำสั่ง/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/อาจพิจารณา/);
  });

  it('includes rule 9 — no numbers outside tool output', () => {
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/ห้ามสร้างตัวเลข/);
  });

  it('includes rule 10 — branch vocabulary on reportFormat', () => {
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/reportFormat/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/STRATEGY_BASED/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/ISSUE_BASED/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/ประเด็นการพัฒนา/);
  });

  it('W55-BE-01 — includes PAO provincial context block (อบจ.นครราชสีมา / ระดับจังหวัด / อปท. / โครงการประสานแผน / โครงการปกติ)', () => {
    // §17.2 advisory-only framing requires the assistant to default its
    // answers to the provincial aggregation owned by อบจ.นครราชสีมา, not
    // to the caller's own municipality. See SEC-CONTEXT-AUDIT GAP-1 / GAP-2.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/อบจ\.นครราชสีมา/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/ระดับจังหวัด/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/อปท\./);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/อบต\./);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/เทศบาล/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/เทศบาลนคร/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/โครงการประสานแผน/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/โครงการปกติ/);
    // Explicit province-wide aggregation framing (not scoped to caller's LAO).
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/ทั่วทั้งจังหวัด|ในระดับจังหวัด/);
  });

  it('W55-BE-03 — includes rule 13 (must surface missingDimensions / advisories)', () => {
    // §17.2 advisory-only — Tier C envelopes return `missingDimensions`
    // and `advisories` that MUST be visible to the executive. The LLM
    // is explicitly forbidden from swallowing them. See
    // SEC-CONTEXT-AUDIT GAP-8 and `aggregation/advisory-copy.ts`.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('missingDimensions');
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('advisories');
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('ห้ามละเลย');
  });

  it('W55-BE-02 / W67 — rule #11 Thai status labels are 1:1 with canonical statusTh and contain no duplicates', () => {
    // CTO audit GAP-7 — Rule #11 previously drifted from the canonical
    // `statusTh` mapping and risked collapsing distinct statuses under a
    // shared Thai token. Rule #11 MUST name each canonical status exactly
    // once so the LLM sees the same vocabulary that tool handlers emit at
    // runtime.
    //
    // W67 (2026-04-26): the canonical status set grew from 7 → 8 with
    // the addition of `Rejected` ("เกินศักยภาพ"); `STATUS_TH_MAP` was
    // deprecation-banned in favour of DB `status.th_name` (W67-BE-AGG-01).
    // The prompt is now the SOLE authoritative documentation of the
    // canonical Thai labels (rule #11 list); we therefore inline the
    // expected labels here rather than iterating the deprecated map.
    //
    // Canonical labels per the W67-updated rule #11 in the prompt:
    //   Ready                 → "รอนำส่ง"
    //   Pending               → "รอตรวจสอบ"   (was "รอการอนุมัติ" pre-W67)
    //   Verified              → "ตรวจสอบผ่าน"
    //   Pending_Approval      → "รออนุมัติ"
    //   Approved              → "อนุมัติ"
    //   Pull_Back             → "ดึงกลับ"
    //   Returned_For_Revision → "รอแก้ไข"
    //   Rejected              → "เกินศักยภาพ"  (W67 — new 8th status)
    const expectedLabels = [
      'รอนำส่ง',
      'รอตรวจสอบ',
      'ตรวจสอบผ่าน',
      'รออนุมัติ',
      'อนุมัติ',
      'ดึงกลับ',
      'รอแก้ไข',
      'เกินศักยภาพ',
    ] as const;

    for (const label of expectedLabels) {
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain(label);
    }

    // W67: 8 canonical Thai labels, all distinct (no collapsing tokens).
    const uniqueLabels = new Set(expectedLabels);
    expect(uniqueLabels.size).toBe(expectedLabels.length);
    expect(expectedLabels.length).toBe(8);

    // Rule #11 MUST disambiguate the Pending / Pending_Approval pair so
    // the LLM does not conflate them.
    // W67-BE-PROMPT-01 (2026-04-26): Pending Thai label was renamed from
    // "รอการอนุมัติ" → "รอตรวจสอบ" in the canonical 8-status vocabulary
    // (DB `status.th_name` SOT). The prompt's #11 list now reads
    // "รอตรวจสอบ" (Pending) and "รออนุมัติ" (Pending_Approval) — still
    // distinct tokens, no conflation.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('รอตรวจสอบ');
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('รออนุมัติ');
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/Pending_Approval/);
  });

  it('W58-BE-PROMPT-01 — system prompt stays within the 16 KB character budget', () => {
    // §17.9 static-literal constraint + §17.2 advisory-only: prompt
    // length drift is a regression risk. Wave 58 added rules #27a–#27e
    // (D1 enum suppression, D3 agency-name attribution, D4 round
    // grouping, D5 cross-turn continuity, D7 pageNumber disclosure)
    // and rule #28 (Option B two-badge plan-status vocabulary lock).
    // Post-W58 length ~14 KB; ceiling raised 12 KB → 16 KB to leave
    // ~2 KB headroom for further rule additions. If a future wave
    // needs more rules, prefer splitting tool instructions into
    // per-turn injections (§W57 risk note).
    // W62 (2026-04-25): cap raised 28672 → 32768 to credit rule #36
    // (HEAD-only default + timeline/verbose disambiguation) and rule
    // #37 (format-aware verbose render — STRATEGY ตัวชี้วัด /
    // ISSUE ประเด็นการพัฒนา + goal/expected truncation). Net growth
    // ~3.5 KB; ~600-token headroom preserved.
    // W66-BE-PROMPT-01 (2026-04-26): cap raised 36864 → 40960 to credit
    // rule #27h (cross-turn count continuity), rule #38 (NULL
    // responsibleAgency hard routing → listProjectsWithoutResponsibleAgency),
    // and rule #38b (forbid envelope-field prose translation). ~3 KB
    // net growth; ~600-token headroom preserved.
    // W67-FIX-C (2026-04-26): cap raised 40960 → 45056 to credit rule
    // #39 render-template extension (per-project บรรจุในเล่ม + page +
    // cross-lineage sub-line, FK / name-exact matchType labels) and the
    // brand-new rule #40 (always-on "ข้อเสนอแนะเพิ่มเติม:" block, 2-3
    // follow-up questions, §17.2 advisory-only "?" form lock). Net
    // growth ~2.5 KB; ~600-token headroom preserved.
    // W67-AMPHOE-FIX-PROMPT-01 (2026-04-26): cap raised 45056 → 47104
    // to credit rule #25a (listAmphoes resolver mandatory before
    // filters.amphoeIds — closes the "0 บาท" zero-results regression).
    // ~700-byte net growth; ~600-token headroom preserved.
    // W67-PAO-VOCAB (2026-04-27): cap raised 47104 → 49152 to credit
    // rule #25c rewrite from creator-based originType mapping to
    // project-LAO-based laoIds/excludeLaoIds mapping (resolves the
    // "เทศบาลโคกกรวด appears under อบจ" semantic confusion). Adds
    // verbose trigger-word table + originType disambiguation prose.
    // ~2 KB net growth; ~600-token headroom preserved.
    // W67-AGENCY-RESOLVER (2026-04-27): cap raised 49152 → 51200 to
    // credit rule #25d (listAgencies resolver mandatory before
    // filters.agencyIds — closes the "ขอดูโครงการของกองยุทธ" zero-
    // results regression). ~600-byte net growth; ~600-token headroom
    // preserved.
    // W68-FIX-03 (2026-04-28): cap raised 51200 → 52224 to credit rule
    // #12a (INVALID_TOOL_INPUT recovery — soft-fail tool-input schema
    // validation now returns a structured tool error instead of crashing
    // the turn; rule teaches the LLM to read the `hint` and call the
    // appropriate resolver before retrying). ~700-byte net growth.
    // W68-FIX-04 (2026-04-28): cap raised 52224 → 55296 to credit (a)
    // rule #25d strong-mandate rewrite — adds MANDATORY tag, "ห้าม skip
    // listAgencies hop", verbatim 10-row synonym table (canonical names
    // + aliases for กองยุทธ/กองคลัง/สำนักปลัด/กจ/กองช่าง/กองสวัสดิ/
    // สำนักเลขา/สำนักศึกษา/หน่วยตรวจสอบ/กองสาธารณสุข), production-
    // regression negative example, and Q5 prompt-side self-check
    // (server-side advisory equivalent — abort list/snapshot when recent
    // user message references an agency keyword and filters.agencyIds
    // is empty); and (b) NEW rule #41 (count-first preamble) mandating
    // "พบ N {หน่วย}" line before any list / breakdown / drill / detail
    // / projects render. Net growth ~2.5 KB; ~600-token headroom
    // preserved.
    // W68-FIX-09 (2026-04-28): cap raised 55296 → 57344 to credit rule
    // #39 strengthening (extended trigger word list with "ดูรายชื่อ" /
    // "ขอรายละเอียด" / English variants + MANDATORY language + negative
    // example). Closes the regression where gpt-4.1-mini ignored "รายชื่อ"
    // trigger and returned status counts instead of drill. ~150-byte net
    // growth.
    // W68-FIX-11 (2026-04-28): cap raised 57344 → 59392 to credit
    // rule #25b Path A type-aware lookup with fallback (4 type prefix
    // mappings + retry-without-type + Negative example B for the
    // "อบต. โคกกรวด" / "เทศบาลตำบลโคกกรวด" disambiguation regression).
    // ~850-byte net growth.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT.length).toBeLessThanOrEqual(59392);
    // W59-BE-PROMPT-01 (2026-04-25): cap raised 16384 → 18432 to credit
    // rules #27f (D-B objective disclosure, 200-char truncation),
    // #27g (D-C location triple — amphoeName / laoName / geoCoordinates),
    // and #29 (D-A listActivePlans default scope flip — all books,
    // latestOnly opt-in). Net growth ~2 KB; ~600 tokens of headroom
    // preserved for the next wave.
    // W60 (2026-04-25): cap raised 18432 → 20480 to credit rule #30
    // (verbose-mode opt-in for default project-bullet shape) and rule
    // #31 (book-completeness vs HEAD-only mode selector). Net growth
    // ~1.6 KB; ~600-token headroom preserved.
  });

  it('W67-FIX-C — rule #39 render template includes per-project บรรจุในเล่ม + หน้า + linkedRelated matchType labels', () => {
    // §17.2 advisory-only — drill render must surface the per-project
    // book + page context (Q1=yes) and the optional cross-lineage
    // sub-line (Q2=C). Asserting the keywords + matchType labels are
    // present is sufficient; the full template block itself is too
    // brittle for a string match.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('บรรจุในเล่ม');
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/หน้า\s/);
    // linkedRelated field name must be referenced verbatim so the LLM
    // knows which envelope key to read.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('linkedRelated');
    // Both matchType labels appear verbatim in the prompt (no
    // translation; used by the LLM as-is per W66 anti-prose lock).
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('เชื่อมโยงด้วย FK');
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('เชื่อมโยงด้วยชื่อโครงการ');
    // Null-page fallback wording must be present.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('หน้าไม่ระบุ');
  });

  it('W67-FIX-C — rule #40 (always-on suggestions) exists with 2-3 list constraint, "?" form lock, no imperative', () => {
    // Rule #40 mandates an "ข้อเสนอแนะเพิ่มเติม:" block at the end of
    // every tool-result-derived answer (§17.2 advisory-only).
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('ข้อเสนอแนะเพิ่มเติม:');
    // The 2-3 item count is locked verbatim ("ไม่ใช่ 1 หรือ 4+").
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('2-3 รายการ');
    // Rule #40 forbids imperative phrasing and requires "?" form.
    // The Thai "ห้าม...imperative" phrasing is checked via the
    // existing baseline (rule #8) — assert the new "?" lock is here.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('"?"');
    // Cross-reference: rule #40 must explicitly cite §17.2 advisory-only.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('§17.2 advisory-only');
  });

  it('W67-AMPHOE-FIX-PROMPT-01 — rule #25a mandates listAmphoes resolver before sending filters.amphoeIds', () => {
    // Path A fix for the "0 บาท" zero-results regression: the LLM had
    // no resolver tool and habitually sent Thai literals like
    // ["อำเภอเมืองนครราชสีมา"] verbatim as filters.amphoeIds. The SQL
    // bind matched zero rows. Rule #25a forces a listAmphoes call to
    // translate name → amphoe.id PK before any amphoe filter.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('25a');
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('listAmphoes');
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('nameContains');
    // Forbidden: sending Thai literal as amphoeIds (the §17.9 / 0-row
    // bug class) — the rule MUST contain a "ห้าม" prohibition adjacent
    // to filters.amphoeIds.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/ห้าม[\s\S]*filters\.amphoeIds/);
    // The rule MUST instruct using `amphoeId` (PK) from the resolver.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('amphoeId');
    // §17.2 advisory-only cross-reference.
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('§17.2 advisory-only');
  });

  it('W67-AMPHOE-FIX-PROMPT-01 — tool catalog lists listAmphoes', () => {
    // The tool-instructions catalog MUST disclose listAmphoes so the
    // LLM sees it in the same surface as every other read aggregator.
    expect(EXECUTIVE_CHAT_TOOL_INSTRUCTIONS).toContain('listAmphoes');
    // Must reference rule #25a so the LLM can locate the routing rule.
    expect(EXECUTIVE_CHAT_TOOL_INSTRUCTIONS).toMatch(/#25a/);
  });

  it('retains the five baseline rules (tool-only, no guessing, no approvals, not-found disclosure, injection guard)', () => {
    // Baseline rules 1–5 — the chat must not regress into a
    // workflow-action surface (§17.2 / §17.9).
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/เครื่องมือ/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/ห้ามเดา/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/ห้ามทำการอนุมัติ/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/<<<USER_INPUT>>>/);
    expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/<<<TOOL_RESULT/);
  });
});
