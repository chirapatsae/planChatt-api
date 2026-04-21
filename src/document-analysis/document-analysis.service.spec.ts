import { DocumentAnalysisService } from './document-analysis.service';

/**
 * Pinning test for the DocumentAnalysisService system prompt.
 *
 * Guards behaviors that previously regressed:
 *   - anti-loop / no-duplicate-phrases clause
 *   - OCR-noise-awareness clause
 *   - sentinel decline clause ("ไม่สามารถสรุปได้จากเอกสารนี้")
 *   - PII-redaction constraint
 *   - OCR-garbled-proper-noun paraphrase guard (N2)
 *
 * The service is instantiated with stub dependencies because this test
 * only inspects the readonly `systemPrompt` field and never invokes
 * repository / OpenAI code paths.
 */
describe('DocumentAnalysisService system prompt', () => {
  let service: DocumentAnalysisService;
  let prompt: string;

  beforeAll(() => {
    // OpenAI client constructor throws when OPENAI_API_KEY is missing.
    // The stub key is never used because the test never invokes any
    // OpenAI method — we only read the `systemPrompt` class field.
    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = 'test-key-not-used';
    }

    // Minimal stubs — the prompt field is populated at construction time
    // and does not depend on the repositories or the usage-quota service.
    const stubRepo = {} as any;
    const stubQuota = {} as any;
    // Wave 37 N2 — 4th constructor dep (AiUsageLogsService) added for
    // rich-detail logging. Stubbed here because this test reads
    // systemPrompt only and never invokes any logging path.
    const stubAiUsageLogs = {} as any;
    service = new DocumentAnalysisService(
      stubRepo,
      stubRepo,
      stubQuota,
      stubAiUsageLogs,
    );
    // Access private readonly field for assertion purposes.
    prompt = (service as any).systemPrompt as string;
  });

  it('is a non-empty string', () => {
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('includes an OCR-garbled-proper-noun paraphrase guard (N2)', () => {
    // Trigger condition: OCR-garbled proper nouns
    expect(prompt).toMatch(/OCR/);
    // Paraphrase alternatives: must mention at least one generic fallback
    expect(prompt).toMatch(/ชื่อเฉพาะ|บริษัทเอกชน|ผู้เสนอราคา/);
  });

  it('preserves the anti-loop / no-duplicate-phrases clause', () => {
    expect(prompt).toMatch(/ห้ามคัดลอกวลีซ้ำ/);
    expect(prompt).toMatch(/ห้ามวนซ้ำคำหรือประโยคเดิม/);
  });

  it('preserves the OCR-noise awareness clause', () => {
    expect(prompt).toMatch(/ข้อความต่อไปนี้มาจาก OCR/);
  });

  it('preserves the sentinel decline clause', () => {
    expect(prompt).toMatch(/ไม่สามารถสรุปได้จากเอกสารนี้/);
    expect(prompt).toMatch(/"other"/);
    expect(prompt).toMatch(/"low"/);
  });

  it('preserves the PII-redaction constraint', () => {
    expect(prompt).toMatch(/ข้อมูลส่วนบุคคลที่อ่อนไหว/);
  });

  it('preserves the role intro clause', () => {
    expect(prompt).toMatch(/เจ้าหน้าที่ช่วยจัดประเภทและสรุปเอกสารราชการไทย/);
  });

  it('places the paraphrase guard after OCR-noise awareness and before the sentinel clause', () => {
    const ocrAwarenessIdx = prompt.indexOf('ข้อความต่อไปนี้มาจาก OCR');
    const paraphraseIdx = prompt.indexOf('OCR (เช่น');
    const sentinelIdx = prompt.indexOf('ไม่สามารถสรุปได้จากเอกสารนี้');

    expect(ocrAwarenessIdx).toBeGreaterThan(-1);
    expect(paraphraseIdx).toBeGreaterThan(-1);
    expect(sentinelIdx).toBeGreaterThan(-1);
    expect(paraphraseIdx).toBeGreaterThan(ocrAwarenessIdx);
    expect(paraphraseIdx).toBeLessThan(sentinelIdx);
  });
});
