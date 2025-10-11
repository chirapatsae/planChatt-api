export interface EmailMessage {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
  path?: string;
  cid?: string;
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}


export interface EmailProvider {
  sendEmail(message: EmailMessage): Promise<EmailResult>;
  getProviderName(): string;
}
