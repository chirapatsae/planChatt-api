# AI_EXEC_CHAT_WHOLE_PLAN_EQUIPMENT_LISTING_HEAD_CONSISTENCY

Wave contract — Executive AI Chat (`backend/src/ai-executive-chat/**`). Make the whole-plan
equipment (ผ.03) LISTING consistent with the whole-plan COUNT. Scope-based source switch in the
aggregator + description/prompt reword. NO new tool (stays 39). Prompt rules now to **#71**.

Date: 2026-07-19 · Related memory: [[exec-chat-rescope]] (rules to #70→#71, 39 tools,
single-LAO, document-vs-HEAD model, caps wave54=143360→147456 / decision-framing=131072→135168).

---

## 1. Inconsistency (user-decided semantics)

For a WHOLE-plan question (no book scope):
- COUNT already = 3 = distinct equipment, latest version of each lineage (HEAD). ✅
  (`getEquipmentBudgetSummary.headItemCount` / `getEquipmentStatusBreakdown.totalCount`, both on
  the `executiveList` HEAD spine.)
- LISTING was wrong = 5 = document rows across books (3 main + 1 แก้ไข + 1 เปลี่ยนแปลง).
  "ขอดูรายละเอียดทั้งสามในแผน" → `listEquipmentInPlan(scope=all)` → 5. So count(3) ≠ listing(5).

USER DECISION (authoritative): whole-plan = **HEAD / distinct latest of each lineage = 3**.

## 2. Root cause

`UnifiedEquipmentAggregatorService.listInPlan` unconditionally routed through
`loadDocumentRows` (`UnifiedEquipmentService.documentList`, `includeSuperseded=true`, no §14.2
REPLACE anti-join) for ALL scopes — a deliberate prior fix (Wave DOCUMENT-EQUIPMENT-LISTING) so a
per-book listing matches the printed ผ.03 book. But that same document path applied to the
whole-plan (`scope='all'|undefined`) case → 5 document rows, diverging from the HEAD count.

## 3. Rule implemented (document-vs-HEAD, scoped)

- **Whole-plan** (`scope='all'` or omitted) → HEAD-of-lineage rows (`loadRows` = `executiveList`,
  the SAME HEAD spine feeding budget/status counts) → equipment listing = 3, agreeing with count.
- **Per-book** (`scope='main' | 'revision' | 'supplement'`) → DOCUMENT rows (`loadDocumentRows`) —
  UNCHANGED ("เล่มหลักมีครุภัณฑ์อะไรบ้าง" stays 3 document; sub-book listings per-book document).

## 4. Fix (code-level, deterministic)

- `unified-equipment-aggregator.service.ts` `listInPlan`: scope-based source switch —
  `const wholePlan = !scope || scope === 'all'; rows = wholePlan ? loadRows(planId) :
  applyScope(loadDocumentRows(planId), scope)`. `applyScope` still filters book scopes correctly.
- Whole-plan HEAD items render the roster-style book label ("เล่มแก้ไข ครั้งที่ 1/2569") via a
  new `useRosterLabel` flag threaded `listInPlan → paginate → toItem`
  (`bookDisplayLabel(rosterHeadBookLabel(row))`, reusing the head-roster helpers). Per-book listing
  keeps the equipment-specific `bookLabel()` ("เล่มแก้ไขครุภัณฑ์ ครั้งที่ 1"). Full detail fields
  (name, book, page, status, budget, category, agency) unchanged.
- `tool-registry.ts` `listEquipmentInPlan.description`: scope-semantics reword (all/omitted → HEAD
  distinct latest = headItemCount count; per-book → document).
- Prompt (`executive-chat-system-prompt.ts`): manifest line reword (TOOL_INSTRUCTIONS) + new
  **Rule #71** (whole-plan count = listing = HEAD; per-book = document; explicit ✗ "ห้ามตอบ 5").
- `listProjectsInPlan`: **NOT changed**. Its default `groupBy='byBookCompleteness'` deliberately
  SKIPS the HEAD filter (document per-book, 5 rows across books) — a hard-won grouping fix. The
  whole-plan project *distinct-latest* set = 3 is served by `listProjectHeadRoster` (Rule #62) /
  dashboard (count). Rule #71 routes whole-plan project HEAD listing to `listProjectHeadRoster`,
  NOT `listProjectsInPlan(scope='all')`. Main agent live-verifies the project whole-plan = 3.

## 5. DAG

```
Backend/API (aggregator scope-switch + label) ─┐
Prompt (Rule #71 + manifest/description reword) ┼──→ Specs (aggregator spine pins + caps) ──→ QA
```

Nodes:
- N1 Backend/API — `listInPlan` scope switch + `paginate`/`toItem` `useRosterLabel` (aggregator).
- N2 Prompt — Rule #71 (SYSTEM_PROMPT) + listEquipmentInPlan manifest reword (TOOL_INSTRUCTIONS)
  + registry description reword.
- N3 Specs — aggregator unit spec: per-book→document assertion kept; NEW whole-plan→HEAD spine
  assertions (executiveList called, documentList not; listing totalCount == budget.headItemCount;
  roster-style label). Cap bumps (wave54 + decision-framing) with credit comments.
- N4 QA (final gate) — tsc, jest (ai-executive-chat + unified-equipment), live SSE E2E per §7.

Dependencies: N3 depends on N1+N2; N4 depends on N1+N2+N3.

## 6. Review-surface / constraints

- No new tool (stays 39) → injection-basic whitelist, runaway-hops, extract-target, 18-arg
  constructor pins untouched. `returnSchema` unchanged (item shape identical; only `bookLabel`
  string content differs by scope). `applyScope` / SCOPE_TO_KIND unchanged.
- Append-only prompt. Caps: wave54 total 143360 → 147456; decision-framing system 131072 → 135168
  (Rule #71 lands in SYSTEM_PROMPT; manifest reword in TOOL_INSTRUCTIONS).
- No raw SQL. Analytical methods (budget/status/category/search) keep HEAD (`loadRows`).
- No regression: headItemCount=3, byBook edit/change split, per-book document listing (main=3,
  แก้ไข=1), head-rosters, optional-planId whole-municipality default (now flows through scope=all
  HEAD → returns 3, matching count).

## 7. Acceptance (main agent live-verifies; single-LAO plan 755ed117 = 3 equip / 3 proj)

- "ครุภัณฑ์ในแผนมีกี่รายการ" → 3; then "ขอดูรายละเอียดทั้งสามรายการ" → the SAME 3 HEAD
  (เครื่องปรับอากาศ เล่มหลัก น.21 / คอมพิวเตอร์ เล่มแก้ไข 1/2569 น.8 / คอมพิวเตอร์ประเภท14 เล่มเปลี่ยนแปลง 1/2569 น.9) — NOT 5.
- "เล่มหลักมีครุภัณฑ์อะไรบ้าง" → 3 document (UNCHANGED: p21/p22/p23).
- "เล่มแก้ไขมีครุภัณฑ์อะไรบ้าง" → 1 (UNCHANGED per-book).
- Whole-plan project distinct listing = 3 HEAD (via head-roster path); per-book project listing
  unchanged (byBookCompleteness).
- No regression: headItemCount=3, byBook split, budget 700k equip / 5.2M proj, head-rosters,
  sub-book listings, optional-planId follow-up.
```
