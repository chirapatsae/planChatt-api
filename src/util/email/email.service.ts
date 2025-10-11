import { Injectable } from '@nestjs/common';
import { EmailProvider, EmailMessage, EmailResult } from './interfaces/email-provider.interface';
import { GmailProvider } from './providers/gmail.provider';
import { PostmarkProvider } from './providers/postmark.provider';

export type EmailProviderType = 'gmail' | 'postmark';

@Injectable()
export class EmailService {
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
        console.warn(`Unknown email provider: ${providerType}, falling back to Gmail`);
        this.provider = new GmailProvider();
    }

    console.log(`Email service initialized with provider: ${this.provider.getProviderName()}`);
  }

  /**
   * Send a single email
   */
  async sendEmail(message: EmailMessage): Promise<EmailResult> {
    return await this.provider.sendEmail(message);
  }
}
