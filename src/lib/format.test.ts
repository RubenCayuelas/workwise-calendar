import { describe, expect, it } from 'vitest';
import { minutesToHHmm } from './dates';
import {
  INVALID_TIME,
  formatHourNumber,
  formatLongDate,
  formatMediumDate,
  formatMonthShort,
  formatTime,
  formatWeekdayLong,
  formatWeekdayShort,
  localDateOf,
  weekRangeLabel,
} from './format';

describe('formatHourNumber', () => {
  it('uses the decimal separator of the language', () => {
    expect(formatHourNumber(150, 'es')).toBe('2,5');
    expect(formatHourNumber(150, 'en')).toBe('2.5');
  });

  it('drops the fraction on a whole hour, as every block in the wireframe shows', () => {
    expect(formatHourNumber(360, 'es')).toBe('6');
    expect(formatHourNumber(60, 'es')).toBe('1');
  });

  it('renders a quarter of an hour without a float tail', () => {
    expect(formatHourNumber(15, 'en')).toBe('0.25');
    expect(formatHourNumber(5760, 'es')).toBe('96');
  });

  it('falls back to Spanish for an unknown language rather than throwing', () => {
    expect(formatHourNumber(150, 'fr')).toBe('2,5');
  });
});

describe('formatTime', () => {
  it('is a 24 h clock, matching the grid the times are drawn against', () => {
    expect(formatTime(480)).toBe('08:00');
    expect(formatTime(930)).toBe('15:30');
    expect(formatTime(1170)).toBe('19:30');
    expect(formatTime(1440)).toBe('24:00');
  });

  it('renders a time outside the day as a visible placeholder instead of throwing', () => {
    // Measured: 25:00 threw out of useFormat().time and took the whole week view down, leaving no
    // way to reach the row and correct it.
    const complaints: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => complaints.push(args);
    try {
      expect(formatTime(1500)).toBe(INVALID_TIME);
      expect(formatTime(-1)).toBe(INVALID_TIME);
      expect(formatTime(Number.NaN)).toBe(INVALID_TIME);
    } finally {
      console.error = original;
    }
    expect(complaints).toHaveLength(3);
  });

  it('does not blame a stored row for a value that was never a time of day', () => {
    // Measured: the message blamed "a stored row" while the source was the drag ghost adding a
    // RUN's net minutes (18 h) to a 07:00 start, which sent the investigation to a clean database.
    const complaints: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => complaints.push(String(args[0]));
    try {
      formatTime(1500);
    } finally {
      console.error = original;
    }
    expect(complaints[0]).toContain('1500');
    expect(complaints[0]).toContain('0-1440');
    expect(complaints[0]).toContain('stored out of range');
    expect(complaints[0]).toContain('net working minutes are not a time of day');
  });

  it('does NOT soften the domain: the engine and every write still throw on it', () => {
    // Softening minutesToHHmm would hide a real engine defect behind a placeholder on screen.
    expect(() => minutesToHHmm(1500)).toThrow(RangeError);
  });
});

describe('dates', () => {
  it('never shifts a day, whatever the process timezone', () => {
    // `new Date('2026-08-13')` parses as UTC, so west of Greenwich it is the 12th.
    const parts = localDateOf('2026-08-13');
    expect(parts.getFullYear()).toBe(2026);
    expect(parts.getMonth()).toBe(7);
    expect(parts.getDate()).toBe(13);
  });

  it('survives the spring DST changeover, when the clocks skip an hour', () => {
    // Europe/Madrid springs forward on 2026-03-29 at 02:00.
    expect(formatDayNumber('2026-03-29')).toBe(29);
    expect(formatWeekdayShort('2026-03-29', 'es')).toBe('Dom');
  });

  it('capitalises the short weekday and drops the abbreviation dot', () => {
    expect(formatWeekdayShort('2026-08-10', 'es')).toBe('Lun');
    expect(formatWeekdayShort('2026-08-12', 'es')).toBe('Mié');
    expect(formatWeekdayShort('2026-08-16', 'es')).toBe('Dom');
    expect(formatWeekdayShort('2026-08-12', 'en')).toBe('Wed');
  });

  it('keeps the long weekday lower case, as Spanish prose wants it', () => {
    expect(formatWeekdayLong('2026-08-27', 'es')).toBe('jueves');
  });

  it('removes the comma es-ES puts after the weekday', () => {
    expect(formatLongDate('2026-08-27', 'es')).toBe('jueves 27 de agosto');
    expect(formatLongDate('2026-08-27', 'en')).toBe('Thursday 27 August');
  });

  it('formats a medium date without abbreviation dots', () => {
    expect(formatMediumDate('2026-08-27', 'es')).toBe('27 ago 2026');
  });

  it('gives the short month the wireframe uses', () => {
    expect(formatMonthShort('2026-08-10', 'es')).toBe('ago');
  });
});

describe('weekRangeLabel', () => {
  it('collapses a week inside one month, exactly as the header shows it', () => {
    // "Semana 33 · 10–16 ago 2026"
    expect(weekRangeLabel('2026-08-10', '2026-08-16', 'es')).toEqual({
      key: 'header.weekRangeSameMonth',
      values: { startDay: '10', endDay: '16', month: 'ago', year: '2026' },
    });
  });

  it('names both months when the week straddles one', () => {
    expect(weekRangeLabel('2026-08-31', '2026-09-06', 'es')).toEqual({
      key: 'header.weekRangeCrossMonth',
      values: { startDay: '31', startMonth: 'ago', endDay: '6', endMonth: 'sept', year: '2026' },
    });
  });

  it('names both years when the week straddles new year', () => {
    expect(weekRangeLabel('2026-12-28', '2027-01-03', 'es')).toEqual({
      key: 'header.weekRangeCrossYear',
      values: {
        startDay: '28',
        startMonth: 'dic',
        startYear: '2026',
        endDay: '3',
        endMonth: 'ene',
        endYear: '2027',
      },
    });
  });
});

function formatDayNumber(date: string): number {
  return localDateOf(date).getDate();
}
