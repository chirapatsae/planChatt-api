/**
 * Shared Quality Rubric — single source of truth for both the AI Project
 * Generator (POST /v1/ai/generate-project-detail) and the AI Pre-Submit
 * Reviewer (POST /v1/ai/pre-submit-review).
 *
 * Why: previously the two endpoints encoded different (informal) quality
 * bars in their prompts, so the reviewer routinely flagged content the
 * generator had just produced. This module defines ONE rubric in one place;
 * generator and reviewer both render the same rubric into their prompt.
 *
 * §16.5 (CLAUDE.md): ISSUE_BASED projects MUST NOT include `indicator`.
 * The `formatRubricFor*` helpers strip the indicator entry when
 * `isIssueBased: true`. Defensive — even if a caller mis-passes data, the
 * rubric will not surface `ตัวชี้วัด` to the model in ISSUE_BASED mode.
 *
 * Stable contract: callers MUST go through the formatter helpers; do not
 * iterate `QUALITY_RUBRIC` directly from outside this file.
 */

export type RubricFieldKey =
  | 'title'
  | 'objective'
  | 'goal'
  | 'expected'
  | 'indicator'
  | 'budget';

export interface RubricEntry {
  key: RubricFieldKey;
  /** Thai display label used in prompt headings (e.g. "ชื่อโครงการ"). */
  label: string;
  /** What GOOD content for this field MUST contain. Each item is a Thai bullet. */
  mustInclude: string[];
  /** What to AVOID for this field. Each item is a Thai bullet. */
  mustAvoid: string[];
  /**
   * Optional few-shot concrete example of HIGH-quality content for this
   * field. Surfaced ONLY to the generator prompt (NOT to the reviewer — we
   * don't want the reviewer to parrot these examples back at the user).
   * Thai, 1–2 sentences, realistic local-government context.
   */
  goodExample?: string;
  /**
   * Optional few-shot concrete example of LOW-quality content for this
   * field (vague / abstract / quota-filler prose). Generator-only.
   */
  badExample?: string;
}

/**
 * Canonical rubric. Order here is the order rendered to the model — it
 * roughly mirrors the order fields appear in the generator output, which
 * helps GPT-4o stay coherent when writing each section.
 */
export const QUALITY_RUBRIC: readonly RubricEntry[] = [
  {
    key: 'title',
    label: 'ชื่อโครงการ',
    mustInclude: [
      'สื่อถึงกลไก/วิธีการหลักของโครงการ (เช่น "ส่งเสริมเกษตรอินทรีย์ด้วยระบบน้ำหยด" แทนที่จะเป็น "ส่งเสริมการเกษตร")',
      'ระบุกลุ่มเป้าหมายหรือพื้นที่เมื่อทำได้โดยกระชับ',
      'ความยาวไม่เกิน 100 ตัวอักษร',
    ],
    mustAvoid: [
      'ชื่อกว้าง ๆ ที่ใช้ได้กับโครงการอื่น เช่น "พัฒนาคุณภาพชีวิต" หรือ "ส่งเสริมการเกษตร" เฉย ๆ',
      'คำคลุมเครือที่ไม่บอกกลไกหรือเทคโนโลยีที่ใช้',
    ],
    goodExample:
      'ส่งเสริมเกษตรอินทรีย์ด้วยระบบน้ำหยดประหยัดน้ำในกลุ่มเกษตรกรตำบลบ้านเหนือ 5 หมู่บ้าน',
    badExample: 'โครงการส่งเสริมการเกษตรและพัฒนาคุณภาพชีวิตประชาชน',
  },
  {
    key: 'objective',
    label: 'วัตถุประสงค์',
    mustInclude: [
      'ความยาว 5–7 ประโยค',
      'ระบุปัญหาหรือช่องว่างที่โครงการต้องการแก้อย่างชัดเจน',
      'ระบุเทคโนโลยี/วิธีการ/เครื่องมือเฉพาะที่จะใช้ (เช่น ระบบน้ำหยด, ปุ๋ยอินทรีย์, แอปพลิเคชันแจ้งเตือนน้ำท่วม)',
      'เชื่อมโยงกับกลุ่มเป้าหมายและบริบทพื้นที่',
    ],
    mustAvoid: [
      'คำกริยานามธรรม ("พัฒนา", "ส่งเสริม", "ยกระดับ") โดยไม่ระบุวิธีการที่จะใช้',
      'ประโยคเดียวสั้น ๆ ที่ไม่ครอบคลุมหลักการและแนวทาง',
    ],
    goodExample:
      'เพื่อลดต้นทุนการผลิตของเกษตรกรผู้ปลูกข้าวในพื้นที่ตำบลบ้านเหนือ 5 หมู่บ้าน ด้วยการติดตั้งระบบน้ำหยดทดแทนการให้น้ำแบบท่วมขัง และส่งเสริมการใช้ปุ๋ยอินทรีย์จากมูลสัตว์ในชุมชน ผ่านการอบรมเกษตรกร 200 ราย และจัดตั้งกลุ่มผลิตปุ๋ยอินทรีย์ประจำหมู่บ้าน',
    badExample:
      'เพื่อส่งเสริมและพัฒนาการเกษตรให้มีคุณภาพและยั่งยืน ยกระดับคุณภาพชีวิตของประชาชนในพื้นที่',
  },
  {
    key: 'goal',
    label: 'เป้าหมาย',
    mustInclude: [
      'ความยาว 5–7 ประโยค',
      'ตัวเลขหรือร้อยละที่จับต้องได้ (เช่น "เกษตรกร 200 ราย", "เพิ่มรายได้ 20%", "ครอบคลุม 5 หมู่บ้าน")',
      'ระบุวิธีการวัดผลที่ชัดเจน (เช่น "สำรวจรายได้ก่อน-หลังโดยใช้แบบสอบถาม", "เก็บข้อมูลผลผลิตจากเกษตรกรกลุ่มตัวอย่าง")',
      'ระบุระยะเวลาดำเนินงาน',
      'ระบุขอบเขตพื้นที่',
    ],
    mustAvoid: [
      'ข้ออ้างที่วัดไม่ได้ เช่น "ประชาชนมีคุณภาพชีวิตที่ดีขึ้น" โดยไม่ระบุว่าวัดอย่างไร',
      'ตัวเลขลอย ๆ ที่ไม่บอกที่มาหรือวิธีคำนวณ',
    ],
    goodExample:
      'เกษตรกรผู้เข้าร่วมโครงการ 200 ราย จาก 5 หมู่บ้านในตำบลบ้านเหนือ สามารถลดต้นทุนการผลิตข้าวลงอย่างน้อย 15% ภายใน 12 เดือน วัดผลด้วยแบบสอบถามต้นทุน-รายได้ก่อนและหลังเข้าร่วม และบันทึกปริมาณน้ำและปุ๋ยที่ใช้ต่อไร่รายเดือน ครอบคลุมพื้นที่เพาะปลูก 1,200 ไร่ ในรอบการผลิตปี 2569',
    badExample:
      'เกษตรกรมีรายได้เพิ่มขึ้นและมีคุณภาพชีวิตที่ดีขึ้นอย่างยั่งยืน ลดต้นทุนการผลิตได้จำนวนมาก',
  },
  {
    key: 'expected',
    label: 'ผลที่คาดว่าจะได้รับ',
    mustInclude: [
      'ความยาว 5–7 ประโยค',
      'แยกผลทางตรงและทางอ้อมอย่างชัดเจน',
      'ครอบคลุมผลระยะสั้น ระยะกลาง และระยะยาว',
      'ตัวเลขหรือสัดส่วนที่จับต้องได้ (เช่น "ลดต้นทุนการผลิต 15%")',
      'อธิบายกลไกที่ก่อให้เกิดผลสั้น ๆ (เช่น "ลดต้นทุนได้ 15% เพราะลดการใช้ปุ๋ยเคมีและน้ำชลประทาน")',
    ],
    mustAvoid: [
      'ผลลอย ๆ ที่ไม่บอกกลไก เช่น "ประชาชนมีความสุขมากขึ้น"',
      'ตัวเลขลอย ๆ ไม่บอกที่มา',
    ],
    goodExample:
      'ผลทางตรงระยะสั้น: เกษตรกร 200 รายลดค่าปุ๋ยเคมีลง 15% จากการใช้ปุ๋ยอินทรีย์ทดแทน และลดปริมาณการใช้น้ำลง 30% จากระบบน้ำหยดภายในฤดูกาลแรก ผลทางตรงระยะกลาง: เกิดกลุ่มผลิตปุ๋ยอินทรีย์ 5 กลุ่มที่สามารถจำหน่ายในชุมชนได้ ผลทางอ้อมระยะยาว: ดินในแปลงเพาะปลูก 1,200 ไร่ฟื้นฟูคุณภาพหลังใช้ปุ๋ยอินทรีย์ต่อเนื่อง 3 ปี ส่งผลให้ผลผลิตต่อไร่เพิ่ม 10%',
    badExample:
      'ประชาชนมีคุณภาพชีวิตที่ดีขึ้น ชุมชนเข้มแข็ง เศรษฐกิจท้องถิ่นได้รับการกระตุ้น และความหลากหลายของผลิตภัณฑ์ทางการเกษตรเพิ่มขึ้น',
  },
  {
    key: 'indicator',
    label: 'ตัวชี้วัด',
    mustInclude: [
      'ความยาว 4–6 ประโยค',
      'ตัวชี้วัดเชิงปริมาณและคุณภาพควบคู่กัน',
      'ค่าฐาน (baseline) และค่าเป้าหมาย (target) ที่ชัดเจน',
      'วิธีการวัดและแหล่งข้อมูลอ้างอิง',
      'ครอบคลุมทั้งตัวชี้วัดผลผลิต (output) และผลลัพธ์ (outcome)',
    ],
    mustAvoid: [
      'ตัวชี้วัดที่ไม่มีตัวเลขหรือเกณฑ์เปรียบเทียบ',
      'baseline ที่ไม่บอกว่ารู้ค่ามาจากที่ใด',
    ],
  },
  {
    key: 'budget',
    label: 'งบประมาณ (สอดแทรกในเนื้อหา ไม่ต้องสร้างหัวข้อใหม่)',
    mustInclude: [
      'ในส่วน "วัตถุประสงค์" หรือ "เป้าหมาย" ให้ระบุขอบเขตเชิงตัวเลขที่ทำให้ผู้ใช้ประมาณงบประมาณที่สมเหตุสมผลได้ เช่น จำนวนผู้รับประโยชน์ จำนวนกิจกรรม จำนวนพื้นที่/หมู่บ้าน',
    ],
    mustAvoid: [
      'ขอบเขตคลุมเครือที่ทำให้กรอกงบประมาณค่าใดก็ดูสมเหตุสมผล',
    ],
  },
];

/**
 * Render a single rubric entry to a Thai bullet block suitable for embedding
 * inside a GPT-4o user-role prompt.
 *
 * `includeExamples = true` appends `goodExample` / `badExample` lines
 * underneath the "ต้องเลี่ยง" block. This is used ONLY by the generator
 * renderer — the reviewer must NOT see the examples (otherwise it tends to
 * parrot the example text back to users as suggestions). Entries without
 * examples silently skip the example block.
 */
function renderEntry(
  entry: RubricEntry,
  opts: { includeExamples: boolean } = { includeExamples: false },
): string {
  const include = entry.mustInclude.map((b) => `   • ${b}`).join('\n');
  const avoid = entry.mustAvoid.map((b) => `   • ${b}`).join('\n');
  const lines: string[] = [
    `▶ ${entry.label}`,
    `  ต้องมี:`,
    include,
    `  ต้องเลี่ยง:`,
    avoid,
  ];
  if (opts.includeExamples && (entry.goodExample || entry.badExample)) {
    if (entry.goodExample) {
      lines.push(`  ✔ ตัวอย่างที่ดี: ${entry.goodExample}`);
    }
    if (entry.badExample) {
      lines.push(`  ✘ ตัวอย่างที่ควรเลี่ยง: ${entry.badExample}`);
    }
  }
  return lines.join('\n');
}

/**
 * Filter the rubric for the active reportFormat.
 * §16.5: ISSUE_BASED MUST NOT include `indicator`.
 */
function selectEntries(opts: { isIssueBased: boolean }): RubricEntry[] {
  return QUALITY_RUBRIC.filter((entry) => {
    if (opts.isIssueBased && entry.key === 'indicator') return false;
    return true;
  }) as RubricEntry[];
}

/**
 * Format the rubric for the GENERATOR prompt.
 *
 * Embed inside `buildStrategyBasedPrompt` / `buildIssueBasedPrompt` AFTER
 * the bracketed field-spec block, BEFORE the trailing 4-section briefing.
 *
 * The model should treat this as a quality bar it MUST satisfy when writing
 * each section.
 */
export function formatRubricForGenerator(opts: {
  isIssueBased: boolean;
}): string {
  const entries = selectEntries(opts);
  const body = entries
    .map((entry) => renderEntry(entry, { includeExamples: true }))
    .join('\n\n');
  return `**เกณฑ์คุณภาพที่ต้องผ่าน (ใช้เกณฑ์นี้เมื่อเขียนแต่ละหัวข้อ — ทุกข้อต้องครบ):**

${body}

หมายเหตุ: เกณฑ์นี้คือเกณฑ์เดียวกับที่ระบบจะใช้ตรวจสอบโครงการในขั้นตอน "AI ตรวจสอบก่อนส่ง" หากเขียนตามเกณฑ์นี้ จะลดข้อแนะนำที่ผู้ใช้ต้องตามแก้ในภายหลัง`;
}

/**
 * Format the rubric for the REVIEWER prompt.
 *
 * Embed inside `generatePreSubmitReview`'s `userPrompt` BEFORE the
 * `เกณฑ์การประเมิน:` numbered list. The reviewer uses this rubric to decide
 * which suggestions are warranted — and crucially, to AVOID flagging content
 * that the generator already produced according to the same rubric.
 */
export function formatRubricForReviewer(opts: {
  isIssueBased: boolean;
}): string {
  const entries = selectEntries(opts);
  // Reviewer MUST NOT receive goodExample / badExample text — if it sees
  // them, GPT-4o tends to echo the example content back to the user as a
  // "suggestion", which is exactly the noise we're trying to suppress.
  const body = entries
    .map((entry) => renderEntry(entry, { includeExamples: false }))
    .join('\n\n');
  return `**เกณฑ์คุณภาพที่ใช้ประเมิน (เกณฑ์เดียวกันกับที่ใช้สร้างโครงการ — โปรดอย่าแนะนำซ้ำสิ่งที่ผู้ใช้ทำตามเกณฑ์แล้ว):**

${body}

แนวทางการให้ข้อแนะนำ:
- หากเนื้อหาผ่านเกณฑ์แล้ว อย่าเสนอข้อแนะนำที่ซ้ำกับสิ่งที่ผ่านอยู่แล้ว
- เสนอข้อแนะนำเฉพาะกรณีที่เนื้อหาขาดหรือไม่ตรงตามเกณฑ์ "ต้องมี"
- หากพบสิ่งที่อยู่ในรายการ "ต้องเลี่ยง" ให้เสนอข้อแนะนำที่ระดับ priority เหมาะสม`;
}
