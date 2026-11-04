export type Folder = 'inbox' | 'all' | 'sent' | 'filtered' | 'spam' | 'drafts';
export type ArchiveStatus = 'pending' | 'forward_accepted' | 'smtp_accepted' | 'failed' | 'unknown';
export type SendStatus = 'scheduled' | 'pending' | 'sending' | 'accepted' | 'failed' | 'unknown';
export interface Address { email: string; name?: string }
export interface MessageSummary {
  id: string;
  mailboxId: string;
  identityAddress?: string;
  direction: 'incoming' | 'outgoing';
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  createdAt: string;
  sizeBytes: number;
  isRead: boolean;
  archiveStatus: ArchiveStatus;
  sendStatus?: SendStatus;
  filterLabel?: string;
  isSpam?: boolean;
  spamReason?: string;
}
export interface AttachmentInfo { filename: string; mimeType: string; sizeBytes: number }
export interface MessageDetail extends MessageSummary {
  replyTo?: Address;
  attachments?: AttachmentInfo[];
  rfcMessageId?: string;
  references: string[];
  expiresAt: string;
  rawAvailable: boolean;
  bodyText?: string;
}
export interface MessagePage { items: MessageSummary[]; nextCursor: string | null }
export interface OutgoingAttachment { filename: string; mimeType: string; contentBase64: string }
export interface SendInput {
  from?: string;
  attachments?: OutgoingAttachment[];
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  replyToMessageId?: string;
  archiveReplyToken?: string;
  draftId?: string;
  scheduledAt?: string;
}
export interface ArchiveReplyContext {
  token: string;
  from?: string;
  to: string[];
  cc: string[];
  subject: string;
  direction: 'incoming' | 'outgoing';
}
export interface DraftInput {
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  attachments?: OutgoingAttachment[];
  replyToMessageId?: string;
  archiveReplyToken?: string;
}
export interface DraftSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  preview: string;
  attachmentCount: number;
  attachmentBytes: number;
  createdAt: string;
  updatedAt: string;
}
export interface DraftDetail extends DraftSummary {
  cc: string;
  bcc: string;
  text: string;
  attachments: OutgoingAttachment[];
  replyToMessageId?: string;
  archiveReplyToken?: string;
}
export interface SendResult { id: string; status: SendStatus; reused: boolean; scheduledAt?: string }
export interface LabelInfo { id: string; name: string }
export interface Brand { name: string; logo: string; primaryColor: string; locale: string }
export type AuthProvider = 'google' | 'access' | 'local';
export interface AuthOptions {
  provider: AuthProvider;
  brand: Brand;
}
export interface SessionInfo {
  user: { email: string };
  brand: Brand;
  mailbox: { id: string; address: string; name: string };
  archiveAddress?: string;
  authProvider?: AuthProvider;
  identities?: Address[];
  labels?: LabelInfo[];
  retentionDays: number;
  maxComposeBytes: number;
  maxAttachments: number;
  maxAttachmentBytes: number;
  mode: 'local' | 'production';
  cache: { usedBytes: number; budgetBytes: number; paused: boolean };
  usageAlerts?: { enabled: boolean; thresholdPercent: number; limit: number };
}
export interface ApiError { error: { code: string; message: string } }
