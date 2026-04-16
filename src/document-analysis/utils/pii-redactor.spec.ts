import { redactPii, PII_MASK } from './pii-redactor';

describe('redactPii', () => {
  describe('positive cases', () => {
    it('masks a bare 13-digit Thai national ID', () => {
      expect(redactPii('เลขบัตร 1234567890123')).toBe(`เลขบัตร ${PII_MASK}`);
    });

    it('masks a dashed Thai national ID in X-XXXX-XXXXX-XX-X form', () => {
      expect(redactPii('บัตร 1-2345-67890-12-3 ของนาย ก')).toBe(
        `บัตร ${PII_MASK} ของนาย ก`,
      );
    });

    it('masks a bare 10-digit Thai mobile phone', () => {
      expect(redactPii('โทร 0812345678')).toBe(`โทร ${PII_MASK}`);
    });

    it('masks a dashed Thai phone 02-123-4567', () => {
      expect(redactPii('ติดต่อ 02-123-4567 ที่สำนักงาน')).toBe(
        `ติดต่อ ${PII_MASK} ที่สำนักงาน`,
      );
    });

    it('masks an email address', () => {
      expect(redactPii('ส่งอีเมลไปที่ staff@example.go.th เพื่อยืนยัน')).toBe(
        `ส่งอีเมลไปที่ ${PII_MASK} เพื่อยืนยัน`,
      );
    });

    it('masks a 10-digit bank account run (not a 13-digit ID case)', () => {
      // 10 digits, not starting with 0 → not a phone; not 13 → not an ID
      expect(redactPii('บัญชี 1234567890 ธนาคาร ก')).toBe(
        `บัญชี ${PII_MASK} ธนาคาร ก`,
      );
    });

    it('masks multiple PII items in one string', () => {
      const input = 'เลขบัตร 1234567890123 โทร 0812345678 อีเมล a@b.co';
      const out = redactPii(input);
      expect(out).toBe(
        `เลขบัตร ${PII_MASK} โทร ${PII_MASK} อีเมล ${PII_MASK}`,
      );
    });
  });

  describe('negative cases (MUST NOT match)', () => {
    it('leaves a 4-digit Buddhist year unchanged', () => {
      expect(redactPii('ปี 2567')).toBe('ปี 2567');
    });

    it('leaves a short 5-digit project ID unchanged', () => {
      expect(redactPii('โครงการ ID 12345')).toBe('โครงการ ID 12345');
    });

    it('leaves a comma-separated amount unchanged (commas break digit runs)', () => {
      expect(redactPii('งบ 9,000,000 บาท')).toBe('งบ 9,000,000 บาท');
    });

    it('leaves a 7-digit reference unchanged', () => {
      expect(redactPii('อ้างอิง 1234567')).toBe('อ้างอิง 1234567');
    });

    it('leaves an empty string unchanged', () => {
      expect(redactPii('')).toBe('');
    });
  });

  describe('idempotency', () => {
    it('re-running redactPii on an already-redacted string leaves it unchanged', () => {
      const once = redactPii('เลขบัตร 1234567890123');
      const twice = redactPii(once);
      expect(twice).toBe(once);
    });
  });
});
