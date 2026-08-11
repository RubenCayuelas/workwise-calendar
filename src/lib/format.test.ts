/**
 * The labels the wireframe specifies, produced from the engine's numbers.
 *
 * The value of these is the decimal comma and the day boundary: 2.5 h has to read
 * "2,5 h" in Spanish, and a date must never shift a day on its way through `Intl`.
 */

import { describe, expect, it } from 'vitest';
import {
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
  });
});

describe('dates', () => {
  it('never shifts a day, whatever the process timezone', () => {
    // The trap: new Date('2026-08-13') parses as UTC, so west of Greenwich it is the
    // 12th. `localDateOf` builds from the parts instead.
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
    // The strip reads "Taller ocupado hasta el jueves 27 de agosto", not "el jueves,".
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
