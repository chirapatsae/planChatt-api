import { createHmac, randomBytes } from 'crypto';

export class UrlSigningUtil {
  private static readonly SECRET_KEY = process.env.FILE_ACCESS_SECRET || 'your-secret-key-change-in-production';
  private static readonly TOKEN_EXPIRY_HOURS = 24; // Token หมดอายุใน 24 ชั่วโมง

  /**
   * สร้าง signed token สำหรับไฟล์
   */
  static generateSignedToken(filename: string): string {
    const expires = Date.now() + (this.TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);
    const data = `${filename}:${expires}`;
    
    const hmac = createHmac('sha256', this.SECRET_KEY);
    hmac.update(data);
    const signature = hmac.digest('hex');
    
    return `${expires}.${signature}`;
  }

  /**
   * ตรวจสอบ signed token
   */
  static validateSignedToken(filename: string, signedToken: string): boolean {
    try {
      const [expiresStr, signature] = signedToken.split('.');
      const expires = parseInt(expiresStr, 10);
      
      // ตรวจสอบว่า token หมดอายุหรือไม่
      if (Date.now() > expires) {
        return false;
      }
      
      // ตรวจสอบ signature
      const data = `${filename}:${expires}`;
      const hmac = createHmac('sha256', this.SECRET_KEY);
      hmac.update(data);
      const expectedSignature = hmac.digest('hex');
      
      return signature === expectedSignature;
    } catch (error) {
      return false;
    }
  }

  /**
   * สร้าง signed URL สำหรับไฟล์
   */
  static generateSignedUrl(baseUrl: string, filename: string): string {
    const token = this.generateSignedToken(filename);
    return `${baseUrl}?token=${token}`;
  }

  /**
   * ตรวจสอบว่า URL หมดอายุหรือไม่
   */
  static isTokenExpired(signedToken: string): boolean {
    try {
      const [expiresStr] = signedToken.split('.');
      const expires = parseInt(expiresStr, 10);
      return Date.now() > expires;
    } catch (error) {
      return true;
    }
  }
} 