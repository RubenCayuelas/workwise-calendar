/**
 * What a cell of the day calendar says when the mouse rests on it. The grey and the dot are the
 * marks; this is the sentence behind them, and it must never call a day full when that day has no
 * plannable hours to be full OF.
 */

import { describe, expect, it } from 'vitest';
import { FAR_MON, LAST_WED, SAT, WED } from '../../testing/fixtures';
import { dayCellNotes } from './dayPickerTitle';
import type { MonthCell } from './monthGrid';
import type { DayMark } from './pickerDays';

function cellOf(date: string, overrides: Partial<MonthCell> = {}): MonthCell {
  return {
    date,
    inMonth: true,
    selectable: true,
    isToday: false,
    isWeekend: false,
    isPast: false,
    ...overrides,
  };
}

const WORKING: DayMark = { isClosed: false, hasRoom: true, freeMinutes: 240 };
const FULL: DayMark = { isClosed: false, hasRoom: false, freeMinutes: 0 };

describe("a day picker cell's notes", () => {
  it('says nothing about a day the server has not answered for yet', () => {
    expect(dayCellNotes(cellOf(WED), undefined)).toEqual([]);
  });

  it('names today first, then the hours it has left', () => {
    expect(dayCellNotes(cellOf(WED, { isToday: true }), WORKING)).toEqual(['today', 'freeHours']);
  });

  it('names the weekend and never calls it full', () => {
    expect(dayCellNotes(cellOf(SAT, { isWeekend: true }), FULL)).toEqual(['weekend']);
  });

  it('never calls a past day full either', () => {
    expect(dayCellNotes(cellOf(LAST_WED, { isPast: true }), FULL)).toEqual([]);
  });

  it('calls a working day with no minutes left full', () => {
    expect(dayCellNotes(cellOf(WED), FULL)).toEqual(['full']);
  });

  it('prefers the reason a day was closed for over the word closed', () => {
    expect(
      dayCellNotes(cellOf(WED), { isClosed: true, note: 'Fair', hasRoom: false, freeMinutes: 0 }),
    ).toEqual(['note']);
  });

  it('falls back to the word closed when the day carries no reason', () => {
    expect(dayCellNotes(cellOf(WED), { isClosed: true, hasRoom: false, freeMinutes: 0 })).toEqual([
      'closed',
    ]);
  });

  it('reports the free hours of a day beyond the horizon, where the dot is off', () => {
    // Past the horizon `hasRoom` is false while the minutes are genuinely free, and "Día completo"
    // is the one thing that would not be true there.
    expect(
      dayCellNotes(cellOf(FAR_MON), { isClosed: false, hasRoom: false, freeMinutes: 300 }),
    ).toEqual(['freeHours']);
  });
});
