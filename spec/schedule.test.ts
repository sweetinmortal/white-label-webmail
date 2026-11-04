import { describe, expect, it } from 'vitest';
import {
  formatScheduleConfirmation,
  formatScheduleTime,
  fromDateTimeLocalValue,
  minimumScheduleValue,
  schedulePresets,
  toDateTimeLocalValue,
} from '../ui/lib/schedule';

describe('schedule helpers', () => {
  it('offers tomorrow morning and afternoon on a weekday in local time', () => {
    const presets = schedulePresets(new Date(2026, 9, 22, 12, 30));
    expect(presets.map((preset) => preset.id)).toEqual(['tomorrow-morning', 'tomorrow-afternoon']);
    expect(presets.map((preset) => toDateTimeLocalValue(preset.value))).toEqual([
      '2026-10-23T08:00',
      '2026-10-23T13:00',
    ]);
  });

  it('adds Monday morning on a weekend when it is not already tomorrow', () => {
    const presets = schedulePresets(new Date(2026, 9, 24, 12, 30));
    expect(presets.map((preset) => preset.id)).toEqual([
      'tomorrow-morning',
      'tomorrow-afternoon',
      'monday-morning',
    ]);
    expect(toDateTimeLocalValue(presets[2].value)).toBe('2026-10-26T08:00');
  });

  it('omits Monday morning on Sunday because Monday is tomorrow', () => {
    const presets = schedulePresets(new Date(2026, 9, 25, 12, 30));
    expect(presets.map((preset) => preset.id)).toEqual(['tomorrow-morning', 'tomorrow-afternoon']);
  });

  it('round-trips local wall-clock picker values', () => {
    const value = new Date(2026, 9, 22, 16, 45);
    const local = toDateTimeLocalValue(value);
    expect(local).toBe('2026-10-22T16:45');
    expect(fromDateTimeLocalValue(local)?.getTime()).toBe(value.getTime());
    expect(fromDateTimeLocalValue('not-a-date')).toBeNull();
    expect(fromDateTimeLocalValue('')).toBeNull();
    expect(fromDateTimeLocalValue('2026-02-31T08:00')).toBeNull();
    expect(fromDateTimeLocalValue('2026-10-22T24:00')).toBeNull();
  });

  it('sets a picker minimum with at least one minute of lead time', () => {
    expect(minimumScheduleValue(new Date(2026, 9, 22, 15, 0, 30))).toBe('2026-10-22T15:02');
  });

  it('formats the confirmation and quick-pick time in local time', () => {
    const value = new Date(2026, 9, 23, 8, 0);
    expect(formatScheduleTime(value)).toBe('8:00');
    expect(formatScheduleConfirmation(value)).toMatch(/^Viernes, 23 de octubre, 8:00$/i);
  });
});
