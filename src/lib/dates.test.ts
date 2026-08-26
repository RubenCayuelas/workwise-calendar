import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  endOfMonth,
  formatDate,
  hhmmToMinutes,
  hoursToMinutes,
  instantToLocalDate,
  isSameMonth,
  isWeekend,
  isoWeekNumber,
  isoWeekYear,
  minutesToHHmm,
  minutesToHours,
  parseDate,
  startOfMonth,
  startOfWeek,
  todayLocal,
  weekDates,
  weekdayOf,
} from './dates';

describe('local days in the shop timezone', () => {
  it('keeps a late-evening instant on the local day, not the UTC one', () => {
    // 22:30 in Madrid on 11 Aug 2026 is 20:30 UTC — same day. But 23:30 local is
    // already 21:30 UTC of the same day, and midnight local is 22:00 UTC of the
    // previous day: that is the case a naive UTC split gets wrong.
    expect(instantToLocalDate(new Date('2026-08-11T22:00:00Z'))).toBe('2026-08-12');
    expect(instantToLocalDate(new Date('2026-08-11T21:59:00Z'))).toBe('2026-08-11');
  });

  it('takes "now" as an injected parameter', () => {
    expect(todayLocal(new Date('2026-08-11T09:00:00Z'))).toBe('2026-08-11');
  });

  it('handles winter time, when Madrid is UTC+1', () => {
    expect(instantToLocalDate(new Date('2026-01-15T23:30:00Z'))).toBe('2026-01-16');
  });
});

describe('parsing', () => {
  it('splits a well-formed day', () => {
    expect(parseDate('2026-08-11')).toEqual({ year: 2026, month: 8, day: 11 });
  });

  it('rejects a day that does not exist instead of rolling it over', () => {
    expect(() => parseDate('2026-02-30')).toThrow(RangeError);
    expect(() => parseDate('2026-8-1')).toThrow(RangeError);
    expect(() => parseDate('not a date')).toThrow(RangeError);
  });

  it('round-trips through formatDate', () => {
    expect(formatDate({ year: 2026, month: 12, day: 31 })).toBe('2026-12-31');
  });
});

describe('day arithmetic', () => {
  it('adds and subtracts days across month and year ends', () => {
    expect(addDays('2026-08-11', 1)).toBe('2026-08-12');
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-08-11', 0)).toBe('2026-08-11');
  });

  it('is immune to the DST changeover', () => {
    // Madrid springs forward on 29 Mar 2026. A local-time implementation would
    // land on the same day twice or skip one.
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });

  it('counts signed days between two days', () => {
    expect(daysBetween('2026-08-11', '2026-08-18')).toBe(7);
    expect(daysBetween('2026-08-18', '2026-08-11')).toBe(-7);
  });
});

describe('weeks', () => {
  it('numbers weekdays from Monday', () => {
    expect(weekdayOf('2026-08-10')).toBe(1);
    expect(weekdayOf('2026-08-14')).toBe(5);
    expect(weekdayOf('2026-08-16')).toBe(7);
  });

  it('flags Saturday and Sunday, the days the engine never touches', () => {
    expect(isWeekend('2026-08-14')).toBe(false);
    expect(isWeekend('2026-08-15')).toBe(true);
    expect(isWeekend('2026-08-16')).toBe(true);
  });

  it('starts the week on Monday, including when asked on a Sunday', () => {
    expect(startOfWeek('2026-08-13')).toBe('2026-08-10');
    expect(startOfWeek('2026-08-16')).toBe('2026-08-10');
    expect(startOfWeek('2026-08-10')).toBe('2026-08-10');
  });

  it('lists the seven days of the week', () => {
    expect(weekDates('2026-08-13')).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
    ]);
  });

  it('numbers ISO weeks, matching the wireframe header', () => {
    // "Semana 33 · 10-16 ago 2026"
    expect(isoWeekNumber('2026-08-10')).toBe(33);
    expect(isoWeekNumber('2026-08-16')).toBe(33);
    expect(isoWeekNumber('2026-01-01')).toBe(1);
  });

  it('reports the ISO week year, which can differ from the calendar year', () => {
    // 1 Jan 2027 is a Friday, so it belongs to the last ISO week of 2026.
    expect(isoWeekNumber('2027-01-01')).toBe(53);
    expect(isoWeekYear('2027-01-01')).toBe(2026);
  });

  it('compares days for sorting', () => {
    expect(compareDates('2026-08-11', '2026-08-12')).toBe(-1);
    expect(compareDates('2026-08-12', '2026-08-11')).toBe(1);
    expect(compareDates('2026-08-11', '2026-08-11')).toBe(0);
  });
});

describe('months', () => {
  it('finds the first and the last day of a month, whatever its length', () => {
    expect(startOfMonth('2026-08-12')).toBe('2026-08-01');
    expect(startOfMonth('2026-08-01')).toBe('2026-08-01');
    expect(endOfMonth('2026-08-12')).toBe('2026-08-31');
    expect(endOfMonth('2026-09-15')).toBe('2026-09-30');
    expect(endOfMonth('2026-12-25')).toBe('2026-12-31');
  });

  it('gets February right in a common year and in a leap one', () => {
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(endOfMonth('2024-02-10')).toBe('2024-02-29');
  });

  it('clamps a 31st onto a shorter month instead of rolling into the next one', () => {
    expect(addMonths('2026-08-31', 1)).toBe('2026-09-30');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-10-31', -8)).toBe('2026-02-28');
  });

  it('crosses the year in both directions', () => {
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonths('2026-08-12', 12)).toBe('2027-08-12');
    expect(addMonths('2026-08-12', -12)).toBe('2025-08-12');
    expect(addMonths('2026-08-12', 0)).toBe('2026-08-12');
  });

  it('tells two months apart when they share a number but not a year', () => {
    expect(isSameMonth('2026-08-01', '2026-08-31')).toBe(true);
    expect(isSameMonth('2026-08-31', '2026-09-01')).toBe(false);
    expect(isSameMonth('2026-01-15', '2025-01-15')).toBe(false);
    expect(isSameMonth('2027-01-01', '2026-12-31')).toBe(false);
  });
});

describe('clock conversions', () => {
  it('reads and writes HH:mm', () => {
    expect(hhmmToMinutes('08:00')).toBe(480);
    expect(hhmmToMinutes('15:30')).toBe(930);
    expect(minutesToHHmm(930)).toBe('15:30');
    expect(minutesToHHmm(0)).toBe('00:00');
  });

  it('rejects a malformed time', () => {
    expect(() => hhmmToMinutes('8h')).toThrow(RangeError);
    expect(() => hhmmToMinutes('08:70')).toThrow(RangeError);
    expect(() => hhmmToMinutes('25:00')).toThrow(RangeError);
  });

  it('survives the round trip that decimal hours would drift on', () => {
    // 0.1 h is the classic offender: 8 * 0.1 !== 0.8 in binary floating point.
    let minutes = 0;
    for (let i = 0; i < 10; i += 1) minutes += hoursToMinutes(2.5);
    expect(minutes).toBe(1500);
    expect(minutesToHours(minutes)).toBe(25);
    expect(hoursToMinutes(0.1) * 10).toBe(60);
  });
});
