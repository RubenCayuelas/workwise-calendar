import { describe, expect, it } from 'vitest';
import { answersFrom, dayIsForced, dayMinutes, keepWorkDates } from './dayWork';
import type { DayWorkRow, PendingHoliday } from '../../lib/api-client';
import { MON, TUE, WED } from '../../testing/fixtures';

function row(name: string, minutes: number, locked = false): DayWorkRow {
  return { projectId: name.toLowerCase(), name, minutes, locked };
}

function day(date: string, rows: DayWorkRow[]): PendingHoliday {
  return { date, name: 'New Year’s Day', rows };
}

describe('a day with no choice to offer', () => {
  it('is one whose work carries a padlock', () => {
    expect(dayIsForced([row('Railing', 360, true)])).toBe(true);
  });

  it('is not one whose work the engine can move', () => {
    expect(dayIsForced([row('Railing', 360)])).toBe(false);
  });

  it('is forced by ONE padlocked row among several', () => {
    expect(dayIsForced([row('Railing', 120), row('Door', 240, true)])).toBe(true);
  });
});

describe('the hours a day holds', () => {
  it('sums its jobs', () => {
    expect(dayMinutes([row('Railing', 360), row('Door', 240)])).toBe(600);
  });

  it('is nothing for a day with nothing on it', () => {
    expect(dayMinutes([])).toBe(0);
  });
});

describe('the answers the panel sends', () => {
  const pending = [
    day(MON, [row('Railing', 360)]),
    day(TUE, [row('Door', 240)]),
    day(WED, [row('Shed', 120, true)]),
  ];

  it('defaults every untouched day to DISPLACE, which is what closing a day has always done', () => {
    expect(answersFrom(pending, new Map())).toEqual([
      { date: MON, keep: false },
      { date: TUE, keep: false },
      // Padlocked: no choice was offered, so the day closes around it.
      { date: WED, keep: true },
    ]);
  });

  it('carries the choice the owner made on a day that had one', () => {
    expect(answersFrom(pending, new Map([[MON, true]]))).toEqual([
      { date: MON, keep: true },
      { date: TUE, keep: false },
      { date: WED, keep: true },
    ]);
  });

  it('IGNORES a choice made against a forced day, so no answer can clear a padlock', () => {
    expect(answersFrom(pending, new Map([[WED, false]]))[2]).toEqual({ date: WED, keep: true });
  });

  it('sends nothing when nothing is pending', () => {
    expect(answersFrom([], new Map())).toEqual([]);
  });
});

describe('the dates the absences form keeps', () => {
  const days = [
    { date: MON, rows: [row('Railing', 360)] },
    { date: TUE, rows: [row('Door', 240)] },
    { date: WED, rows: [row('Shed', 120, true)] },
  ];

  it('is empty when nothing was chosen, because displacing is the default', () => {
    // A forced day is still in it: its work cannot be moved, so it stays whatever the form shows.
    expect(keepWorkDates(days, new Map())).toEqual([WED]);
  });

  it('carries the days the owner chose to keep', () => {
    expect(keepWorkDates(days, new Map([[MON, true]]))).toEqual([MON, WED]);
  });

  it('IGNORES a choice made against a forced day, so no answer can clear a padlock', () => {
    expect(keepWorkDates(days, new Map([[WED, false]]))).toEqual([WED]);
  });

  it('sends nothing for a range with no work on it', () => {
    expect(keepWorkDates([], new Map())).toEqual([]);
  });
});
