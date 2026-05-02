import * as nodemailer from 'nodemailer';
import { EmailProvider, EmailMessage, EmailResult, EmailAttachment } from '../interfaces/email-provider.interface';

export class GmailProvider implements EmailProvider {
  private transporter: nodemailer.Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }

  async sendEmail(message: EmailMessage): Promise<EmailResult> {
    try {
      const mailOptions = this.buildMailOptions(message);
      const info = await this.transporter.sendMail(mailOptions);
      return {
        success: true,
        messageId: info.messageId,
      };
    } catch (error) {
      console.error('Gmail error sending email:', {
        error: error.message,
        code: error.code,
        command: error.command,
        response: error.response
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // removed: sendBulkEmails, verifyConnection (not used currently)

  getProviderName(): string {
    return 'Gmail';
  }

  private buildMailOptions(message: EmailMessage): nodemailer.SendMailOptions {
    // W90 deliverability fix (2026-05-01):
    // - Removed `X-Priority: 1`, `X-MSMail-Priority: High`, `Importance: high` —
    //   three high-priority headers in combination is a documented Gmail spam
    //   trigger; transactional notifications are not "high priority" mail.
    // - Removed custom `messageId` at `@projectbank.com` — that domain has no
    //   matching DKIM/SPF, and a Message-ID whose domain disagrees with `From:`
    //   triggers heuristic spam scoring on Gmail-to-Gmail delivery.
    // - Removed `List-Unsubscribe: <mailto:unsubscribe@projectbank.com>` — the
    //   target mailbox does not exist; Gmail validates the list-unsubscribe
    //   target as part of its bulk-sender policy. Re-add only when a real
    //   unsubscribe handler ships.
    // - Removed `X-Auto-Response-Suppress` (deprecated Microsoft header) and
    //   the bespoke X-Mailer / X-Entity-Ref-ID headers (no operational value).
    // Result: nodemailer / Gmail SMTP auto-generate a Message-ID at the From
    // domain (`@gmail.com`), which DKIM-aligns and lands in the inbox.
    const mailOptions: nodemailer.SendMailOptions = {
      from: message.from || `"ระบบธนาคารโครงการ อบจ.นม" <${process.env.EMAIL_USER}>`,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: process.env.EMAIL_USER,
    };

    if (message.replyTo) {
      mailOptions.replyTo = message.replyTo;
    }

    if (message.cc) {
      mailOptions.cc = message.cc;
    }

    if (message.bcc) {
      mailOptions.bcc = message.bcc;
    }

    if (message.attachments && message.attachments.length > 0) {
      mailOptions.attachments = message.attachments.map(attachment => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
        path: attachment.path,
        cid: attachment.cid,
      }));
    }

    return mailOptions;
  }
}
