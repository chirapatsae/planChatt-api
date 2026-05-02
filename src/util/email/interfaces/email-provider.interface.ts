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
  /** W90-SAFEGUARD-01 — true when MAIL_ENABLED was false (suppressed) or MAIL_SANDBOX_TO rerouted the send. */
  sandboxed?: boolean;
}


export interface EmailProvider {
  sendEmail(message: EmailMessage): Promise<EmailResult>;
  getProviderName(): string;
}
