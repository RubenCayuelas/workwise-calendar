import { describe, expect, it } from 'vitest';
import {
  adjacentInWindows,
  manualWindowsOf,
  netMinutesBetween,
  netMinutesOf,
  reachableRuns,
  usesManualOnlyTime,
} from './manualWindow';
import { hhmmToMinutes as t } from './dates';
import type { WorkPeriod } from '../types';

/** The documented split shift, and the hour of margin at either end of it. */
const PERIODS: WorkPeriod[] = [
  { startMinutes: t('08:00'), endMinutes: t('14:00') },
  { startMinutes: t('15:30'), endMinutes: t('19:30') },
];
const WINDOWS = manualWindowsOf(PERIODS, 60, 60);

describe('manualWindowsOf', () => {
  it('widens the first and last period by the margins, leaving lunch the only hole', () => {
    expect(WINDOWS).toEqual([
      { startMinutes: t('07:00'), endMinutes: t('14:00') },
      { startMinutes: t('15:30'), endMinutes: t('20:30') },
    ]);
  });

  it('is the periods themselves when both margins are zero', () => {
    expect(manualWindowsOf(PERIODS, 0, 0)).toEqual(PERIODS);
  });

  it('fuses a shift configured with no lunch into one window', () => {
    const noLunch: WorkPeriod[] = [
      { startMinutes: t('08:00'), endMinutes: t('14:00') },
      { startMinutes: t('14:00'), endMinutes: t('19:30') },
    ];
    expect(manualWindowsOf(noLunch, 60, 60)).toEqual([
      { startMinutes: t('07:00'), endMinutes: t('20:30') },
    ]);
  });

  it('keeps a single-period day one window', () => {
    expect(manualWindowsOf([PERIODS[0]], 60, 60)).toEqual([
      { startMinutes: t('07:00'), endMinutes: t('15:00') },
    ]);
  });

  it('has nothing to widen on a day with no periods', () => {
    expect(manualWindowsOf([], 60, 60)).toEqual([]);
  });

  it('never runs off either end of the day', () => {
    const early: WorkPeriod[] = [{ startMinutes: t('00:30'), endMinutes: t('23:30') }];
    expect(manualWindowsOf(early, 120, 120)).toEqual([{ startMinutes: 0, endMinutes: 1440 }]);
  });
});

describe('netMinutesBetween', () => {
  it('skips the lunch break in both views and the margins in the periods only', () => {
    // 10:00 to 17:30: four hours of morning plus two of afternoon, lunch uncounted.
    expect(netMinutesBetween(PERIODS, t('10:00'), t('17:30'))).toBe(360);
    expect(netMinutesBetween(WINDOWS, t('10:00'), t('17:30'))).toBe(360);
    // 07:00 to 09:00 is margin plus period: one hour of work, two of manual window.
    expect(netMinutesBetween(PERIODS, t('07:00'), t('09:00'))).toBe(60);
    expect(netMinutesBetween(WINDOWS, t('07:00'), t('09:00'))).toBe(120);
  });

  it('is zero for an empty or inverted span', () => {
    expect(netMinutesBetween(WINDOWS, t('10:00'), t('10:00'))).toBe(0);
    expect(netMinutesBetween(WINDOWS, t('12:00'), t('10:00'))).toBe(0);
  });
});

describe('netMinutesOf', () => {
  it('adds the intervals up', () => {
    expect(netMinutesOf(PERIODS)).toBe(600);
    expect(netMinutesOf(WINDOWS)).toBe(720);
    expect(netMinutesOf([])).toBe(0);
  });
});

describe('reachableRuns', () => {
  it('carries a row inside a window across the lunch break to the end of the day', () => {
    expect(reachableRuns(WINDOWS, t('10:00'), t('20:30'))).toEqual([
      { startMinutes: t('10:00'), endMinutes: t('14:00') },
      { startMinutes: t('15:30'), endMinutes: t('20:30') },
    ]);
    // The margins are inside the window, so a row in the top margin reaches just as far.
    expect(netMinutesOf(reachableRuns(WINDOWS, t('07:00'), t('20:30')))).toBe(720);
  });

  it('keeps a row that starts in a hole inside that hole', () => {
    // Dropped into the lunch band: it may reach the afternoon's start and no further.
    expect(reachableRuns(WINDOWS, t('14:30'), t('20:30'))).toEqual([
      { startMinutes: t('14:30'), endMinutes: t('15:30') },
    ]);
  });

  it('closes the last hole at the end of the axis', () => {
    // Past the last window entirely — only reachable on an axis widened to show a row
    // left over from a longer working day.
    expect(reachableRuns(WINDOWS, t('21:00'), t('22:00'))).toEqual([
      { startMinutes: t('21:00'), endMinutes: t('22:00') },
    ]);
  });
});

describe('adjacentInWindows', () => {
  it('joins the two halves around the lunch break', () => {
    expect(adjacentInWindows(WINDOWS, t('14:00'), t('15:30'))).toBe(true);
  });

  it('joins rows that touch', () => {
    expect(adjacentInWindows(WINDOWS, t('10:00'), t('10:00'))).toBe(true);
  });

  it('separates rows with workable time between them', () => {
    expect(adjacentInWindows(WINDOWS, t('10:00'), t('11:00'))).toBe(false);
    // Half an hour of MARGIN between them is workable by hand, so they are two stretches.
    // Read against the periods alone this pair would join, which is the trap the manual
    // window exists to close.
    expect(adjacentInWindows(WINDOWS, t('07:30'), t('08:00'))).toBe(false);
    expect(netMinutesBetween(PERIODS, t('07:30'), t('08:00'))).toBe(0);
  });
});

describe('usesManualOnlyTime', () => {
  it('is false for work that sits inside the periods', () => {
    expect(usesManualOnlyTime(PERIODS, [{ startMinutes: t('10:00'), durationMinutes: 240 }])).toBe(false);
    expect(
      usesManualOnlyTime(PERIODS, [
        { startMinutes: t('10:00'), durationMinutes: 240 },
        { startMinutes: t('15:30'), durationMinutes: 120 },
      ]),
    ).toBe(false);
  });

  it('is true for a row holding margin minutes, on either side of the day', () => {
    expect(usesManualOnlyTime(PERIODS, [{ startMinutes: t('07:00'), durationMinutes: 60 }])).toBe(true);
    expect(usesManualOnlyTime(PERIODS, [{ startMinutes: t('07:30'), durationMinutes: 120 }])).toBe(true);
    expect(usesManualOnlyTime(PERIODS, [{ startMinutes: t('19:00'), durationMinutes: 90 }])).toBe(true);
  });

  it('is true for a row sitting in the lunch band', () => {
    expect(usesManualOnlyTime(PERIODS, [{ startMinutes: t('14:30'), durationMinutes: 60 }])).toBe(true);
  });

  it('notices when only the CONTINUATION reaches into a margin', () => {
    expect(
      usesManualOnlyTime(PERIODS, [
        { startMinutes: t('12:00'), durationMinutes: 120 },
        { startMinutes: t('15:30'), durationMinutes: 300 },
      ]),
    ).toBe(true);
  });
});
