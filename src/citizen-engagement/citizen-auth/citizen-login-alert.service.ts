import { Injectable, Logger } from '@nestjs/common';

import { decryption } from 'src/util/encryption.util';
import { EmailService } from 'src/util/email/email.service';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenSession } from '../entities/citizen-session.entity';
import {
  sessionDeviceLabel,
  sessionLocationLabel,
} from '../../common/session-registry/session-labels.util';

/**
 * CitizenLoginAlertService — the "ตรวจพบการเข้าสู่ระบบใหม่" (new-device)
 * notification for the CITIZEN cohort (login-alerts / device-session-management,
 * Batch 2).
 *
 * Fired FIRE-AND-FORGET from the mint helper AFTER the auth response is already
 * on its way (post-auth), so it never blocks or slows login. The trigger is a
 * session whose `device_hash` has no prior non-revoked row for the account,
 * skipping the account's very first session (no "new sign-in" on signup).
 *
 * §17.3 isolation: self-contained "แผนชัด" card (never couples to the staff
 * notification templates). The recipient is decrypted from `email_enc` ONLY at
 * send time and is NEVER logged; the IP is shown as the coarse /24 subnet only.
 */
@Injectable()
export class CitizenLoginAlertService {
  private readonly logger = new Logger(CitizenLoginAlertService.name);

  constructor(private readonly emailService: EmailService) {}

  private static resolveFrontendBase(): string {
    const fromNotify = process.env.NOTIFY_ACTION_LINK_BASE;
    if (typeof fromNotify === 'string' && fromNotify.length > 0) return fromNotify;
    const fromExplicit = process.env.FRONTEND_URL;
    if (typeof fromExplicit === 'string' && fromExplicit.length > 0)
      return fromExplicit;
    return 'http://localhost:5173';
  }

  /** Human-readable Asia/Bangkok timestamp (e.g. `24 ก.ค. 2569 14:05 น.`). */
  private formatBangkok(at: Date): string {
    try {
      const s = new Intl.DateTimeFormat('th-TH', {
        timeZone: 'Asia/Bangkok',
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(at);
      return `${s} น.`;
    } catch {
      return at.toISOString();
    }
  }

  /**
   * Send the new-device alert for `session` to the citizen `identity`. Awaited
   * only inside the fire-and-forget wrapper in the mint helper — a mail failure
   * must never surface to the login response.
   */
  async sendNewDeviceAlert(
    identity: CitizenIdentity,
    session: CitizenSession,
  ): Promise<void> {
    if (!identity.emailEnc) return;
    const recipient = await decryption(identity.emailEnc);

    const alias = identity.displayAlias || 'ผู้ใช้งาน';
    const device = sessionDeviceLabel(session.browserLabel, session.osLabel);
    const location =
      sessionLocationLabel(
        session.geoCity,
        session.geoCountry,
        session.subnet24,
      ) || 'ไม่ทราบตำแหน่ง';
    // Citizen IP is PDPA-encrypted at rest; surface ONLY the coarse /24 subnet
    // (never decrypt the full address for a notification).
    const ipDisplay = session.subnet24 || 'ไม่ทราบ';
    const when = this.formatBangkok(session.createdAt ?? new Date());

    const base = CitizenLoginAlertService.resolveFrontendBase().replace(
      /\/+$/,
      '',
    );
    const secureUrl = `${base}/citizen/forgot-password`;
    const devicesUrl = `${base}/citizen/settings/sessions`;

    const subject = '[หนองกระทุ่ม] แจ้งเตือน: มีการเข้าสู่ระบบใหม่';

    const text =
      `เรียน ${alias}\n\n` +
      `ตรวจพบการเข้าสู่ระบบใหม่เข้าบัญชีประชาชนของท่านกับเทศบาลตำบลหนองกระทุ่ม\n\n` +
      `อุปกรณ์/เบราว์เซอร์: ${device}\n` +
      `ตำแหน่งโดยประมาณ: ${location}\n` +
      `เวลา: ${when}\n` +
      `IP (โดยประมาณ): ${ipDisplay}\n\n` +
      `หากเป็นท่าน ไม่ต้องดำเนินการใด ๆ\n` +
      `หากไม่ใช่ท่าน โปรดรักษาความปลอดภัยบัญชี:\n` +
      `- เปลี่ยนรหัสผ่าน: ${secureUrl}\n` +
      `- ออกจากระบบอุปกรณ์อื่น: ${devicesUrl}\n\n` +
      `ด้วยความเคารพ\nเทศบาลตำบลหนองกระทุ่ม`;

    const safeAlias = this.escapeHtml(alias);
    const safeDevice = this.escapeHtml(device);
    const safeLocation = this.escapeHtml(location);
    const safeWhen = this.escapeHtml(when);
    const safeIp = this.escapeHtml(ipDisplay);
    const safeSecureUrl = this.escapeHtml(secureUrl);
    const safeDevicesUrl = this.escapeHtml(devicesUrl);

    const row = (label: string, value: string): string =>
      `<tr><td style="padding:4px 0;font-size:13px;color:#5f6368;width:150px;">${label}</td>` +
      `<td style="padding:4px 0;font-size:13px;color:#202124;font-weight:600;">${value}</td></tr>`;

    const html =
      `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"/>` +
      `<meta name="viewport" content="width=device-width, initial-scale=1.0"/>` +
      `<title>${this.escapeHtml(subject)}</title></head>` +
      `<body style="margin:0;padding:0;background-color:#f5f6f8;` +
      `font-family:'Sarabun','Noto Sans Thai',Arial,sans-serif;color:#202124;-webkit-font-smoothing:antialiased;">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f6f8;">` +
      `<tr><td align="center" style="padding:32px 12px;">` +
      `<table role="presentation" width="600" cellpadding="0" cellspacing="0" ` +
      `style="width:600px;max-width:100%;background-color:#ffffff;border:1px solid #e8eaed;border-radius:12px;">` +
      // Header wordmark
      `<tr><td align="center" style="padding:40px 40px 0 40px;">` +
      `<div style="font-size:26px;font-weight:700;color:#2563eb;letter-spacing:0.5px;line-height:1;">แผนชัด</div>` +
      `<div style="font-size:13px;color:#5f6368;margin-top:6px;">ระบบแผนชัด (PlanCHATT) &middot; เทศบาลตำบลหนองกระทุ่ม</div>` +
      `</td></tr>` +
      // Divider
      `<tr><td style="padding:24px 40px 0 40px;"><div style="border-top:1px solid #e8eaed;font-size:0;line-height:0;">&nbsp;</div></td></tr>` +
      // Body
      `<tr><td style="padding:24px 40px 8px 40px;">` +
      `<h1 style="font-size:18px;font-weight:600;color:#202124;margin:0 0 16px 0;line-height:1.5;">ตรวจพบการเข้าสู่ระบบใหม่</h1>` +
      `<p style="font-size:14px;line-height:1.7;margin:0 0 4px 0;color:#202124;">เรียน ${safeAlias}</p>` +
      `<p style="font-size:14px;line-height:1.7;margin:0 0 16px 0;color:#3c4043;">` +
      `มีการเข้าสู่ระบบบัญชีประชาชนของท่านกับเทศบาลตำบลหนองกระทุ่มจากอุปกรณ์ใหม่</p>` +
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;width:100%;">` +
      row('อุปกรณ์/เบราว์เซอร์', safeDevice) +
      row('ตำแหน่งโดยประมาณ', safeLocation) +
      row('เวลา', safeWhen) +
      row('IP (โดยประมาณ)', safeIp) +
      `</table>` +
      `<div style="border-radius:8px;background-color:#fef2f2;border:1px solid #fecaca;padding:14px 16px;margin:0 0 8px 0;">` +
      `<p style="font-size:13px;line-height:1.6;margin:0 0 8px 0;color:#991b1b;font-weight:600;">` +
      `หากไม่ใช่ท่าน โปรดรักษาความปลอดภัยบัญชี</p>` +
      `<p style="font-size:13px;line-height:1.6;margin:0;color:#3c4043;">` +
      `<a href="${safeSecureUrl}" style="color:#2563eb;text-decoration:none;">เปลี่ยนรหัสผ่าน</a>` +
      ` &middot; ` +
      `<a href="${safeDevicesUrl}" style="color:#2563eb;text-decoration:none;">ออกจากระบบอุปกรณ์อื่น</a></p>` +
      `</div>` +
      `<p style="font-size:12px;line-height:1.6;margin:8px 0 0 0;color:#5f6368;">หากเป็นท่าน ไม่ต้องดำเนินการใด ๆ</p>` +
      `</td></tr>` +
      // Divider
      `<tr><td style="padding:8px 40px 0 40px;"><div style="border-top:1px solid #e8eaed;font-size:0;line-height:0;">&nbsp;</div></td></tr>` +
      // Footer
      `<tr><td align="center" style="padding:20px 40px 32px 40px;">` +
      `<p style="font-size:12px;color:#5f6368;line-height:1.6;margin:0;">` +
      `อีเมลนี้ถูกส่งจากระบบแผนชัด (PlanCHATT) โดยอัตโนมัติ กรุณาอย่าตอบกลับอีเมลฉบับนี้</p>` +
      `<p style="font-size:12px;color:#5f6368;line-height:1.6;margin:8px 0 0 0;">` +
      `เทศบาลตำบลหนองกระทุ่ม อำเภอเมืองนครราชสีมา จังหวัดนครราชสีมา</p>` +
      `</td></tr>` +
      `</table></td></tr></table></body></html>`;

    await this.emailService.sendEmail({ to: recipient, subject, text, html });
    // PII discipline — log the identity uuid only, never the email / IP.
    this.logger.log(
      `citizen.login_alert.new_device identityId=${identity.id} sid=${session.id}`,
    );
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
