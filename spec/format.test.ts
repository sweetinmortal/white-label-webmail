import { describe, expect, it } from 'vitest';
import { formatDate, formatListDate } from '../ui/lib/format';

const now = new Date(2026, 9, 23, 18, 0);
const todayAt = (hour: number, minute: number) => new Date(2026, 9, 23, hour, minute).toISOString();
const olderAt = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute).toISOString();

describe('formatListDate', () => {
  it('shows only the time for messages received today', () => {
    expect(formatListDate(todayAt(14, 15), 'es-EC', now)).toBe('14:15');
    expect(formatListDate(todayAt(0, 5), 'es-EC', now)).toBe('00:05');
  });

  it('keeps the compact date for older messages', () => {
    const older = olderAt(22, 23, 59);
    expect(formatListDate(older, 'es-EC', now)).toBe(formatDate(older, false, 'es-EC'));
    expect(formatListDate(older, 'es-EC', now)).not.toMatch(/^\d{2}:\d{2}$/);
  });
});
