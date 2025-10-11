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
    const mailOptions: nodemailer.SendMailOptions = {
      from: message.from || `"ระบบธนาคารโครงการ อบจ.นม" <${process.env.EMAIL_USER}>`,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: {
        'X-Priority': '1', // High priority
        'X-MSMail-Priority': 'High',
        'Importance': 'high',
        'X-Mailer': 'Project Bank System v1.0',
        'X-Entity-Ref-ID': 'project-bank-notification',
        'List-Unsubscribe': '<mailto:unsubscribe@projectbank.com>',
        'X-Auto-Response-Suppress': 'All',
      },
      // เพิ่ม message ID และ references
      messageId: `<${Date.now()}-${Math.random().toString(36).substr(2, 9)}@projectbank.com>`,
      // ตั้งค่า reply-to
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
