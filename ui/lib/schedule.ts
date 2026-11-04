import { safeLocale } from './format';

export type SchedulePresetId = 'tomorrow-morning' | 'tomorrow-afternoon' | 'monday-morning';

export interface SchedulePreset {
  id: SchedulePresetId;
  label: string;
  value: Date;
}

const MORNING_HOUR = 8;
const AFTERNOON_HOUR = 13;

function atLocalTime(day: Date, hour: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0, 0, 0);
}

function nextLocalDay(day: Date, days: number): Date {
  const result = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  result.setDate(result.getDate() + days);
  return result;
}

/** The quick choices use the viewer's local time, as does datetime-local. */
export function schedulePresets(now = new Date()): SchedulePreset[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = nextLocalDay(today, 1);
  const presets: SchedulePreset[] = [
    { id: 'tomorrow-morning', label: 'Mañana por la mañana', value: atLocalTime(tomorrow, MORNING_HOUR) },
    { id: 'tomorrow-afternoon', label: 'Mañana por la tarde', value: atLocalTime(tomorrow, AFTERNOON_HOUR) },
  ];
  if (today.getDay() === 0 || today.getDay() === 6) {
    const monday = nextLocalDay(today, today.getDay() === 6 ? 2 : 1);
    const mondayMorning = atLocalTime(monday, MORNING_HOUR);
    if (mondayMorning.getTime() > presets[0].value.getTime()) {
      presets.push({ id: 'monday-morning', label: 'Lunes por la mañana', value: mondayMorning });
    }
  }
  return presets.filter((preset) => preset.value.getTime() > now.getTime());
}

export function formatScheduleTime(value: Date, locale = 'es-EC'): string {
  const time = new Intl.DateTimeFormat(safeLocale(locale), {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(value);
  return time.replace(/^0/, '');
}

export function formatScheduleDay(value: Date, locale = 'es-EC'): string {
  const day = new Intl.DateTimeFormat(safeLocale(locale), {
    weekday: 'short', day: 'numeric', month: 'short',
  }).format(value);
  return day.charAt(0).toUpperCase() + day.slice(1);
}

export function formatScheduleConfirmation(value: string | Date, locale = 'es-EC'): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : '';
  const day = new Intl.DateTimeFormat(safeLocale(locale), {
    weekday: 'long', day: 'numeric', month: 'long',
  }).format(date);
  return `${day.charAt(0).toUpperCase() + day.slice(1)}, ${formatScheduleTime(date, locale)}`;
}

export function toDateTimeLocalValue(value: Date): string {
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

export function fromDateTimeLocalValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const result = new Date(0);
  result.setFullYear(year, month - 1, day);
  result.setHours(hour, minute, second, 0);
  if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== day
    || result.getHours() !== hour || result.getMinutes() !== minute || result.getSeconds() !== second) return null;
  return result;
}

export function minimumScheduleValue(now = new Date()): string {
  const minimum = new Date(now.getTime() + 2 * 60_000);
  minimum.setSeconds(0, 0);
  return toDateTimeLocalValue(minimum);
}
