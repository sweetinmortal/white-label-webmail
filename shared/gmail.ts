export interface GmailSyncStatus {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  email?: string;
  lastSyncedAt?: string;
  lastError?: string;
  matchedCount: number;
  scanning: boolean;
  callbackUrl: string;
}
