/**
 * Wave AI-EXEC-CHAT-DOCUMENT-EQUIPMENT-LISTING-AND-VERBOSITY — prompt-rule
 * spec for Rule #60 (list verbosity: list-intent shows names + minimal
 * only; never verbose objective/goal/expected/indicator unless the #30
 * trigger is present; "ขอรายละเอียดโครงการ X" → verbose single project).
 *
 * Append-only guarantee: #59 anchor survives, #60 sits after it, and the
 * Thai-only closing line still terminates the prompt.
 */
import { EXECUTIVE_CHAT_SYSTEM_PROMPT } from '../executive-chat-system-prompt';

describe('list-verbosity prompt rule #60', () => {
  it('rule #60 — list-intent = names + minimal; no verbose unless triggered', () => {
    const idx = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '60. ระดับรายละเอียดของการ list',
    );
    expect(idx).toBeGreaterThan(-1);
    const tail = EXECUTIVE_CHAT_SYSTEM_PROMPT.slice(idx, idx + 1400);
    // list-intent → names + minimal.
    expect(tail).toContain('มีอะไรบ้าง');
    expect(tail).toContain('ชื่อ');
    // Forbid verbose fields + the verbose:true flag.
    expect(tail).toContain('ห้ามแสดง verbose');
    expect(tail).toContain('verbose: true');
    expect(tail).toContain('วัตถุประสงค์');
    // Verbose only on explicit #30 trigger.
    expect(tail).toContain('พร้อมรายละเอียด');
    // Single-project detail follow-up path.
    expect(tail).toContain('ขอรายละเอียดโครงการ X');
    expect(tail).toContain('ตัวเดียว');
    // Cross-references.
    expect(tail).toContain('กฎ #30');
    expect(tail).toContain('กฎ #35');
    expect(tail).toContain('#57');
  });

  it('append-only — #59 anchor survives; #60 sits after it; Thai closing line terminates', () => {
    const idx59 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '59. ไทม์ไลน์เล่มแผน / ลำดับเล่ม',
    );
    const idx60 = EXECUTIVE_CHAT_SYSTEM_PROMPT.indexOf(
      '60. ระดับรายละเอียดของการ list',
    );
    expect(idx59).toBeGreaterThan(-1);
    expect(idx60).toBeGreaterThan(idx59);
    expect(
      EXECUTIVE_CHAT_SYSTEM_PROMPT.trimEnd().endsWith(
        'ทุกคำตอบตอบเป็นภาษาไทย เว้นแต่ผู้ใช้ถามเป็นภาษาอื่น',
      ),
    ).toBe(true);
  });
});
