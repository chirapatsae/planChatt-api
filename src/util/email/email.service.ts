import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider, EmailMessage, EmailResult } from './interfaces/email-provider.interface';
import { GmailProvider } from './providers/gmail.provider';
import { PostmarkProvider } from './providers/postmark.provider';
import { maskEmail } from '../../notifications/email/utils/mask-email.util';

export type EmailProviderType = 'gmail' | 'postmark';

/**
 * Single-email-shape regex used to validate `MAIL_SANDBOX_TO` before any
 * recipient rewrite. Defensive against env-var poisoning / header injection
 * (W90-SAFEGUARD-01 §9). Intentionally narrow: one local-part, one domain,
 * no comma / semicolon / whitespace / angle brackets / quotes.
 */
const SANDBOX_EMAIL_RE = /^[^\s,;<>"']+@[^\s,;<>"']+\.[^\s,;<>"']+$/;

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private provider: EmailProvider;

  constructor() {
    this.initializeProvider();
  }

  private initializeProvider(): void {
    const providerType = (process.env.EMAIL_PROVIDER as EmailProviderType) || 'gmail';

    switch (providerType) {
      case 'gmail':
        this.provider = new GmailProvider();
        break;
      case 'postmark':
        this.provider = new PostmarkProvider();
        break;
      default:
        this.logger.warn(`Unknown email provider: ${providerType}, falling back to Gmail`);
        this.provider = new GmailProvider();
    }

    this.logger.log(`Email service initialized with provider: ${this.provider.getProviderName()}`);
  }

  /**
   * Send a single email.
   *
   * W90-SAFEGUARD-01 — Non-prod sandbox guard.
   * This method is the SINGLE chokepoint before any provider transmits over
   * the network. The guard MUST run before `this.provider.sendEmail` so that
   * a misconfigured dev/staging env never opens an SMTP/API connection to a
   * real citizen address.
   *
   * Truth table:
   *   MAIL_ENABLED !== 'true'        → short-circuit, return sandboxed:true
   *   MAIL_ENABLED === 'true' + SBX  → reroute to MAIL_SANDBOX_TO, sandboxed:true
   *   MAIL_ENABLED === 'true' + ''   → normal send, sandboxed:false
   */
  async sendEmail(message: EmailMessage): Promise<EmailResult> {
    const enabled = (process.env.MAIL_ENABLED ?? '').trim() === 'true';

    // Branch 1: master kill-switch. NEVER invoke provider when disabled.
    if (!enabled) {
      this.logger.log(
        `[Mail sandbox] suppressed (MAIL_ENABLED!=true) to=${this.maskRecipient(message.to)} subject=${message.subject}`,
      );
      return {
        success: true,
        messageId: 'sandboxed',
        sandboxed: true,
      };
    }

    // Branch 2: enabled + sandbox reroute. Validate sandbox address shape
    // before rewriting (W90-SAFEGUARD-01 §9 header-injection defense).
    const sandboxToRaw = (process.env.MAIL_SANDBOX_TO ?? '').trim();
    if (sandboxToRaw) {
      if (!SANDBOX_EMAIL_RE.test(sandboxToRaw)) {
        this.logger.error(
          `[Mail sandbox] MAIL_SANDBOX_TO is set but malformed; refusing to send to avoid leaking to original recipient subject=${message.subject}`,
        );
        return {
          success: false,
          error: 'MAIL_SANDBOX_TO is set but not a valid single email address',
          sandboxed: true,
        };
      }

      this.logger.log(
        `[Mail sandbox] rerouted to=${this.maskRecipient(sandboxToRaw)} originalTo=${this.maskRecipient(message.to)} subject=${message.subject}`,
      );

      const rerouted: EmailMessage = {
        ...message,
        to: sandboxToRaw,
        cc: undefined,
        bcc: undefined,
      };
      const result = await this.provider.sendEmail(rerouted);
      return { ...result, sandboxed: true };
    }

    // Branch 3: enabled + no sandbox. Normal production path.
    const result = await this.provider.sendEmail(message);
    return { ...result, sandboxed: false };
  }

  /**
   * Mask a recipient (string | string[]) for log output. Delegates to the
   * shared `maskEmail` helper so we never leak raw PII to logs (W83).
   */
  private maskRecipient(to: string | string[] | undefined): string {
    if (!to) return '***';
    if (Array.isArray(to)) {
      return to.map((addr) => maskEmail(addr)).join(',');
    }
    return maskEmail(to);
  }
}
