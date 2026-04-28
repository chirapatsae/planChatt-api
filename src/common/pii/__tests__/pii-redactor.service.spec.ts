/**
 * pii-redactor.service.spec.ts (SEC-W44-02)
 *
 * Unit tests for the shared PiiRedactorService.  Covers:
 *   - Thai citizen ID (dashed, bare, space-separated)
 *   - Thai phone (mobile + landline, with/without dashes)
 *   - Email
 *   - OCR blob with 20 PII instances — counts match
 *   - Structured DTO with mixed allow/strip fields
 *   - False-positive negative case: "5 ล้านบาท" should NOT be redacted
 *   - Idempotency: already-redacted text is not re-redacted
 */

import { PiiRedactorService } from '../pii-redactor.service';
import {
  PROJECT_PROMPT_POLICY,
  REVIEW_PROMPT_POLICY,
} from '../field-policies';

const MASK = '[ข้อมูลส่วนบุคคล]';

describe('PiiRedactorService', () => {
  let service: PiiRedactorService;

  beforeEach(() => {
    service = new PiiRedactorService();
  });

  // ─────────────────────────────────────────────────────────────
  // Thai citizen ID
  // ─────────────────────────────────────────────────────────────

  describe('Thai citizen ID', () => {
    it('masks dashed Thai national ID', () => {
      const { output, counts } = service.redactText(
        'เลขประจำตัว 1-2345-67890-12-3 ครับ',
        { endpoint: 'test' },
      );
      expect(output).toContain(MASK);
      expect(output).not.toContain('1-2345-67890-12-3');
      expect(counts.thaiId).toBe(1);
    });

    it('masks bare 13-digit Thai national ID', () => {
      const { output, counts } = service.redactText(
        'เลขบัตรประชาชน 1234567890123',
        { endpoint: 'test' },
      );
      expect(output).toContain(MASK);
      expect(counts.thaiId).toBe(1);
    });

    it('masks space-separated Thai national ID (OCR artifact)', () => {
      const { output, counts } = service.redactText(
        '1 2345 67890 12 3',
        { endpoint: 'test' },
      );
      expect(output).toContain(MASK);
      expect(counts.thaiId).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Thai phone
  // ─────────────────────────────────────────────────────────────

  describe('Thai phone', () => {
    it('masks 10-digit mobile with dashes', () => {
      const { output, counts } = service.redactText(
        'โทร 081-234-5678 หรือ 044-123-456',
        { endpoint: 'test' },
      );
      expect(output).not.toContain('081-234-5678');
      expect(output).not.toContain('044-123-456');
      expect(counts.thaiPhone).toBe(2);
    });

    it('masks bare 10-digit mobile', () => {
      const { output, counts } = service.redactText(
        'โทร 0812345678',
        { endpoint: 'test' },
      );
      expect(output).toContain(MASK);
      expect(counts.thaiPhone).toBe(1);
    });

    it('masks landline with dashes', () => {
      const { output } = service.redactText('02-123-4567', {
        endpoint: 'test',
      });
      expect(output).toContain(MASK);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Email
  // ─────────────────────────────────────────────────────────────

  describe('email', () => {
    it('masks email addresses', () => {
      const { output, counts } = service.redactText(
        'ติดต่อ user@example.go.th หรือ admin@test.org',
        { endpoint: 'test' },
      );
      expect(output).not.toContain('user@example.go.th');
      expect(output).not.toContain('admin@test.org');
      expect(counts.email).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // OCR blob — 20 PII instances
  // ─────────────────────────────────────────────────────────────

  describe('OCR blob with 20 PII instances', () => {
    it('counts every PII instance correctly', () => {
      // 5 dashed IDs + 5 phones + 5 emails + 5 bare 13-digit IDs = 20
      const blob = [
        '1-2345-67890-12-3',
        '2-3456-78901-23-4',
        '3-4567-89012-34-5',
        '4-5678-90123-45-6',
        '5-6789-01234-56-7',
        '081-111-1111',
        '082-222-2222',
        '083-333-3333',
        '084-444-4444',
        '085-555-5555',
        'a@b.co',
        'c@d.co',
        'e@f.co',
        'g@h.co',
        'i@j.co',
        '1111222233334',
        '2222333344445',
        '3333444455556',
        '4444555566667',
        '5555666677778',
      ].join('\n');

      const { output, counts } = service.redactText(blob, {
        endpoint: 'ocr-test',
      });
      expect(counts.thaiId).toBe(10); // 5 dashed + 5 bare
      expect(counts.thaiPhone).toBe(5);
      expect(counts.email).toBe(5);
      // Zero residual raw PII
      expect(output.match(/\d-\d{4}-\d{5}-\d{2}-\d/g)).toBeNull();
      expect(output.match(/\b\d{13}\b/g)).toBeNull();
      expect(output.match(/@/g)).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Structured DTO with mixed policies
  // ─────────────────────────────────────────────────────────────

  describe('structured DTO redaction', () => {
    it('strips personal keys and allows project fields with text-redact', () => {
      const dto = {
        firstName: 'สมชาย',
        lastName: 'ใจดี',
        citizenId: '1234567890123',
        phone: '0812345678',
        email: 'somchai@example.com',
        title: 'โครงการก่อสร้างถนน',
        objective: 'ติดต่อนายสมชาย 081-234-5678',
        userPrompt: 'สร้างโครงการ',
        additionalContext: 'ผู้ประสานงาน somchai@test.org โทร 0899999999',
      };
      const { output, counts } = service.redactStructuredFields(
        dto,
        PROJECT_PROMPT_POLICY,
      );
      // Strip
      expect((output as Record<string, unknown>).firstName).toBeUndefined();
      expect((output as Record<string, unknown>).lastName).toBeUndefined();
      expect((output as Record<string, unknown>).citizenId).toBeUndefined();
      expect((output as Record<string, unknown>).phone).toBeUndefined();
      expect((output as Record<string, unknown>).email).toBeUndefined();
      // Allow + text-redact
      expect(output.title).toBe('โครงการก่อสร้างถนน');
      expect(output.objective).toContain(MASK);
      expect(output.additionalContext).toContain(MASK);
      expect(counts.thaiPhone + counts.email).toBeGreaterThanOrEqual(2);
    });

    it('handles nested arrays with [] wildcard', () => {
      const dto = {
        project: { title: 'proj' },
        attachments: [
          { aiTopic: 'เรื่อง', aiSummary: 'ติดต่อ 0812345678' },
          { aiTopic: 'อีกเรื่อง', aiSummary: 'email a@b.co' },
        ],
      };
      const { output, counts } = service.redactStructuredFields(
        dto,
        REVIEW_PROMPT_POLICY,
      );
      expect(output.attachments[0].aiSummary).toContain(MASK);
      expect(output.attachments[1].aiSummary).toContain(MASK);
      expect(counts.thaiPhone).toBe(1);
      expect(counts.email).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Negative / false-positive cases
  // ─────────────────────────────────────────────────────────────

  describe('false positives (must NOT redact)', () => {
    it('does not redact "5 ล้านบาท"', () => {
      const { output, counts } = service.redactText('งบประมาณ 5 ล้านบาท', {
        endpoint: 'test',
      });
      expect(output).toBe('งบประมาณ 5 ล้านบาท');
      expect(counts.thaiId).toBe(0);
      expect(counts.thaiPhone).toBe(0);
      expect(counts.longDigit).toBe(0);
    });

    it('does not redact 4-digit Buddhist year', () => {
      const { output } = service.redactText('ปีงบประมาณ 2567', {
        endpoint: 'test',
      });
      expect(output).toBe('ปีงบประมาณ 2567');
    });

    it('does not redact comma-grouped amounts', () => {
      const { output } = service.redactText('งบประมาณ 9,000,000 บาท', {
        endpoint: 'test',
      });
      expect(output).toBe('งบประมาณ 9,000,000 บาท');
    });

    it('does not redact 8-digit unformatted budget', () => {
      const { output, counts } = service.redactText('10000000 บาท', {
        endpoint: 'test',
      });
      expect(output).toBe('10000000 บาท');
      expect(counts.longDigit).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Idempotency
  // ─────────────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('re-redacting already-masked text is a no-op on the masked portion', () => {
      const first = service.redactText('โทร 0812345678', {
        endpoint: 'test',
      });
      const second = service.redactText(first.output, { endpoint: 'test' });
      expect(second.output).toBe(first.output);
      expect(second.counts.thaiPhone).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Telemetry
  // ─────────────────────────────────────────────────────────────

  describe('telemetry', () => {
    it('emits a structured log line when PII is found', () => {
      const svc = service as unknown as {
        logger: { log: (msg: string) => void };
      };
      const spy = jest
        .spyOn(svc.logger, 'log')
        .mockImplementation(() => undefined);
      service.redactText('โทร 0812345678', { endpoint: 'unit-test' });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('event=pii.redact'),
      );
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('endpoint=unit-test'),
      );
    });

    it('does NOT emit when no PII is found (zero-noise)', () => {
      const svc = service as unknown as {
        logger: { log: (msg: string) => void };
      };
      const spy = jest
        .spyOn(svc.logger, 'log')
        .mockImplementation(() => undefined);
      service.redactText('ไม่มีข้อมูลส่วนบุคคล', { endpoint: 'unit-test' });
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
