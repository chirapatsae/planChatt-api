# AI_EXEC_CHAT_FOLLOWUP_CONTINUITY_OPTIONAL_PLANID

Wave contract — Executive AI Chat (`backend/src/ai-executive-chat/**`). Follow-up-continuity
bug fix. Deterministic backend default + light prompt reinforcement. NO new tool (stays 39).

Date: 2026-07-18 · Related memory: [[exec-chat-rescope]] (rules to #70, prompt caps
wave54=139264 / decision-framing=131072).

---

## 1. Bug (reproduced live, gpt-4.1-mini, c-level, single conversation)

- Turn 1: "ครุภัณฑ์ในแผนมีกี่รายการ งบรวมเท่าไหร่ สถานะอะไรบ้าง" → LLM calls
  `getEquipmentBudgetSummary` + `getEquipmentStatusBreakdown` (both DEFAULT to
  whole-municipality, no planId) → 3 รายการ / 700k / อนุมัติ 3. OK.
- Turn 2 (same conversation): "ขอดูรายละเอียดทั้งสามรายการ" → LLM calls
  `listEquipmentInPlan` with NO anchored planId → old handler HARD-REQUIRED a UUID →
  `totalCount:0` → "ไม่พบข้อมูลครุภัณฑ์". WRONG (should list the 3).

## 2. Root cause

`listEquipmentInPlan` (handler `executive-tool-handlers.ts`) required a UUID planId and
returned an empty `totalCount:0` envelope + a `message` telling the LLM to call
`listActivePlans` first. Because turn 1 used tools that default to whole-municipality, NO
planId was ever anchored; the LLM ignored the `message` and reported "ไม่พบ". The underlying
loader (`UnifiedEquipmentService.loadEpgHeadRows` / `documentList`) already applies the plan
filter CONDITIONALLY (`if (developmentPlanId) …`) so `undefined` = whole-municipality =
(single-LAO) the one plan's items — exactly like the budget/status tools. `listProjectsInPlan`
had the IDENTICAL guard → same latent bug for project detail/listing follow-ups.

## 3. Fix (deterministic — match sibling whole-municipality default)

- `listEquipmentInPlan` + `listProjectsInPlan`: planId now OPTIONAL.
  - Missing / empty / whitespace planId → `undefined` filter → WHOLE-MUNICIPALITY listing.
  - Valid UUID → filter by that plan (unchanged).
  - **Malformed (non-empty non-UUID) planId → KEEP the guidance message** (decision §5).
- `paramsSchema.required` changed `['planId']` → `[]` for both tools (else the pre-handler
  param validator rejects a no-planId call before the whole-municipality default can run).
- Tool descriptions + prompt manifest lines reworded: planId OPTIONAL; omit = whole
  municipality (current plan for this LAO).
- Light prompt reinforcement in the two manifest lines (TOOL_INSTRUCTIONS only): a
  detail/listing follow-up after a plan-less turn may call these tools without planId.
  Backend default is the primary fix; prompt is secondary.

## 4. DAG

```
Backend/API (handlers + aggregator sig + registry) ─┐
Prompt (manifest reword, TOOL_INSTRUCTIONS only) ────┼──→ Specs (update pins) ──→ QA (tsc+jest+live SSE)
```

Nodes:
- N1 Backend/API — handler default-to-whole-municipality (both tools) + aggregator
  `listInPlan` signature widen + registry `required:[]` + descriptions.
- N2 Prompt — manifest reword (listEquipmentInPlan/listProjectsInPlan) + reinforcement.
- N3 Specs — update pins that asserted empty-on-missing-planId + `required` planId.
- N4 QA (final gate) — tsc, jest (exec-chat + unified-equipment), live SSE E2E per §6.

Dependencies: N3 depends on N1+N2; N4 depends on N1+N2+N3.

## 5. Decision — malformed (non-empty non-UUID) planId

CHOSEN: keep the guidance message for a non-empty MALFORMED planId; only missing/empty/
whitespace defaults to whole-municipality. Justification:
1. Fixes the reproduced bug (turn 2 sends NO planId = empty string in handler).
2. A garbled/hallucinated UUID is a genuine LLM error that might mean a DIFFERENT plan —
   silently returning whole-municipality would mask it; the message is more debuggable.
3. Minimizes spec churn — the malformed-case specs (wave57 Q-G2, equipment-tools Thai-name,
   BE-W49-01 non-UUID strings) stay green (their `/planId ต้องเป็น UUID/` and `listActivePlans`
   assertions still match the new message); only the missing/empty pins change.
   The whole-municipality path needs a live/QB-mocked DataSource which those `{}`-stub specs
   lack, so keeping the malformed message avoids QB-throw rewrites.

## 6. Acceptance (main agent live-verifies; single-LAO plan 755ed117 = 3 equip / 3 proj)

- Turn 1 count/budget/status → 3 / 700k / อนุมัติ 3; Turn 2 "ขอดูรายละเอียดทั้งสามรายการ"
  → lists the 3 equipment (เครื่องปรับอากาศ น.21, คอมพิวเตอร์ประเภท14 น.22, คอมพิวเตอร์ น.23) — NOT "ไม่พบ".
- Direct "ขอดูรายละเอียดครุภัณฑ์ทั้งหมดในแผน" (no prior planId) → 3.
- Projects: a detail/listing follow-up with no anchored planId → returns items.
- Regression: planId provided (normal flow) unchanged; document-equipment=3, head-rosters,
  budget 5.2M, byBook split, all prior fixes intact.

## 7. Constraints

No new tool (stays 39) → review-surface pins (injection-basic whitelist, runaway-hops,
extract-target, 18-arg constructor) untouched. returnSchema unchanged (planId=NIL_UUID
sentinel for whole-municipality; format uuid still satisfied). Append-only prompt. Cap:
wave54 total 139264 → 143360 (TOOL_INSTRUCTIONS grew ~0.6KB); decision-framing untouched.
No raw SQL (conditional `andWhere` only; wave53-no-raw-sql gate unaffected).
```
