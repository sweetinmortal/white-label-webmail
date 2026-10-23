import type { Address } from '../../shared/contracts';

export function safeLocale(locale?: string): string {
  try {
    Intl.DateTimeFormat(locale || 'es-EC').format();
    return locale || 'es-EC';
  } catch {
    return 'es-EC';
  }
}

export function formatDate(value: string, withTime = false, locale = 'es-EC'): string {
  return new Intl.DateTimeFormat(safeLocale(locale), {
    day: '2-digit', month: 'short', year: withTime ? 'numeric' : undefined,
    hour: withTime ? '2-digit' : undefined, minute: withTime ? '2-digit' : undefined,
  }).format(new Date(value));
}

/**
 * Gmail-style list date: today's messages show only the time, while older
 * messages keep the compact day/month format.
 */
export function formatListDate(value: string, locale = 'es-EC', now = new Date()): string {
  const parsed = new Date(value);
  const isToday = parsed.getFullYear() === now.getFullYear()
    && parsed.getMonth() === now.getMonth()
    && parsed.getDate() === now.getDate();
  if (!isToday) return formatDate(value, false, locale);
  return new Intl.DateTimeFormat(safeLocale(locale), {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(parsed);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function initials(address?: Address): string {
  const source = address?.name?.trim() || address?.email || '?';
  const words = source.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : source.slice(0, 2)).toUpperCase();
}

export function avatarTone(id: string): string {
  const tones = ['blue', 'green', 'violet', 'peach', 'mint', 'lavender'];
  return tones[id.split('').reduce((sum, character) => sum + character.charCodeAt(0), 0) % tones.length];
}

export function displayAddress(address?: Address): string {
  if (!address) return '';
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

export function splitEmails(value: string): string[] {
  return value.split(/[;,\s]+/).map((email) => email.trim()).filter(Boolean);
}

export function hasValidEmails(value: string): boolean {
  return splitEmails(value).every((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}

export function replySubject(subject: string): string {
  return /^re:\s*/i.test(subject) ? subject : `Re: ${subject}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
