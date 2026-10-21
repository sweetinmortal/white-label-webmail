import type { Address, Brand } from '../shared/contracts';

export interface Env {
  DB: D1Database;
  MAIL?: R2Bucket;
  ASSETS: Fetcher;
  APP_ENV?: string;
  APP_ORIGIN?: string;
  COMPANY_CONFIG?: string;
  ARCHIVE_EMAIL?: string;
  ALLOWED_USERS?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CF_USAGE_API_TOKEN?: string;
  USAGE_ALERT_EMAIL?: SendEmail;
  ARCHIVE_EMAIL_COPY?: SendEmail;
  ARCHIVE_LINK_KEY?: string;
  MAILJET_API_KEY?: string;
  MAILJET_API_SECRET?: string;
  MAILJET_WEBHOOK_USER?: string;
  MAILJET_WEBHOOK_PASSWORD?: string;
  DEV_AUTH_EMAIL?: string;
}
export interface MailConfig {
  brand: Brand;
  appOrigin: string;
  mailbox: { id: string; address: string; name: string };
  identities?: Address[];
  archiveAddress: string;
  allowedUsers: string[];
  retentionDays: number;
  cleanupEnabled: boolean;
  storageBudgetBytes: number;
  maxMessageBytes: number;
  maxComposeBytes: number;
  maxAttachments: number;
  maxAttachmentBytes: number;
  dailyRecipientLimit: number;
  monthlyRecipientLimit: number;
  mode: 'local' | 'production';
  provider: 'local' | 'mailjet';
  storageProvider?: 'r2' | 'turso';
  usageAlerts?: { enabled: boolean; thresholdPercent: number; zeroTrustSeatLimit: number; delivery?: 'mailjet' | 'cloudflare' };
  archiveCopies?: { enabled: boolean; maxDecoratedBytes: number; incomingMode?: 'attachment' | 'forward-with-notice' };
  accessTeamDomain: string;
  accessAudience: string;
  authProvider?: 'access' | 'google';
  googleClientId?: string;
}
export interface Identity { email: string; mailboxIds: string[] }
export interface IncomingEmail {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  headers: Headers;
  forward(address: string): Promise<unknown>;
  setReject(reason: string): void;
}
