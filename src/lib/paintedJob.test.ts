/**
 * The rows a painted band becomes on the day it was painted on. ONE function, read by the write path
 * and by the band the grid keeps drawing, so a preview and a save cannot draw different shapes.
 */

import { describe, expect, it } from 'vitest';
import { hhmmToMinutes as t, minutesToHHmm } from './dates';
import { manualWindowsOf } from './manualWindow';
import { paintedSegments } from './paintedJob';

const PERIODS = [
  { startMinutes: t('08:00'), endMinutes: t('14:00') },
  { startMinutes: t('15:30'), endMinutes: t('19:30') },
];

/** 07:00-14:00 and 15:30-20:30: a hand gesture reads the margins too. */
const WINDOWS = manualWindowsOf(PERIODS, 60, 60);

/** No afternoon at all, so the day's last window runs to its own margin. */
const MORNING_ONLY = manualWindowsOf([PERIODS[0]], 60, 60);

function rows(windows: readonly { startMinutes: number; endMinutes: number }[], from: string, hours: number) {
  return paintedSegments(windows, t(from), Math.round(hours * 60)).segments.map(
    (row) => `${minutesToHHmm(row.startMinutes)}-${minutesToHHmm(row.startMinutes + row.durationMinutes)}`,
  );
}

describe('the rows a painted band becomes', () => {
  it('is one row when it fits inside a window', () => {
    expect(rows(WINDOWS, '10:00', 3)).toEqual(['10:00-13:00']);
  });

  it('is cut at the comida, never stored straddling it', () => {
    // `compose` re-derives nothing on a locked row, so an uncut row would be STORED across the
    // break — the one shape no row in the app may have.
    expect(rows(WINDOWS, '13:00', 3)).toEqual(['13:00-14:00', '15:30-17:30']);
  });

  it('may sit in a visual margin, which is workable time the owner chose', () => {
    expect(rows(WINDOWS, '07:00', 2)).toEqual(['07:00-09:00']);
    expect(rows(WINDOWS, '19:00', 1.5)).toEqual(['19:00-20:30']);
  });

  it('reads a start inside the comida as the first minute that can hold work', () => {
    expect(rows(WINDOWS, '14:30', 2)).toEqual(['15:30-17:30']);
  });

  it('stops at the end of the day and reports what did not fit', () => {
    // 10:00 leaves 4 h + 5 h = 9 h of the manual window. 12 h asked for, so 3 h carry on.
    const plan = paintedSegments(WINDOWS, t('10:00'), 12 * 60);

    expect(plan.taken).toBe(9 * 60);
    expect(plan.overflow).toBe(3 * 60);
    expect(plan.segments.map((row) => minutesToHHmm(row.startMinutes))).toEqual(['10:00', '15:30']);
  });

  it('takes the whole band when the day holds it, leaving no overflow', () => {
    const plan = paintedSegments(WINDOWS, t('10:00'), 3 * 60);

    expect(plan.taken).toBe(3 * 60);
    expect(plan.overflow).toBe(0);
  });

  it('never leaves a remainder too small to be a row', () => {
    // 9 h of room and 9 h 10 m asked for: taking all 9 would strand 10 minutes, which is not a row
    // anywhere. A quarter is left behind for the hours that carry on.
    const plan = paintedSegments(WINDOWS, t('10:00'), 9 * 60 + 10);

    expect(plan.overflow).toBeGreaterThanOrEqual(15);
    expect(plan.taken + plan.overflow).toBe(9 * 60 + 10);
  });

  it('works on a day with no afternoon', () => {
    expect(rows(MORNING_ONLY, '12:00', 2)).toEqual(['12:00-14:00']);
    // The day ends at the top margin's edge, 15:00, so only 3 h can be taken from 12:00.
    expect(paintedSegments(MORNING_ONLY, t('12:00'), 6 * 60).taken).toBe(3 * 60);
  });

  it('takes nothing where the release leaves no room at all', () => {
    const plan = paintedSegments(WINDOWS, t('20:30'), 2 * 60);

    expect(plan.segments).toEqual([]);
    expect(plan.taken).toBe(0);
    expect(plan.overflow).toBe(2 * 60);
  });

  it('conserves the hours asked for, whatever the shift', () => {
    for (const windows of [WINDOWS, MORNING_ONLY]) {
      for (const from of ['07:00', '09:30', '13:45', '15:30', '18:00']) {
        for (const minutes of [15, 90, 240, 600, 1000]) {
          const plan = paintedSegments(windows, t(from), minutes);
          const stored = plan.segments.reduce((total, row) => total + row.durationMinutes, 0);

          expect(stored).toBe(plan.taken);
          expect(plan.taken + plan.overflow).toBe(minutes);
        }
      }
    }
  });
});
