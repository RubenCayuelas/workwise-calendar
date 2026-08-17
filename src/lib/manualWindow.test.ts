import { describe, expect, it } from 'vitest';
import {
  adjacentInWindows,
  clockEndOf,
  dayEndMinutes,
  firstWorkingMinute,
  latestStartFor,
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

describe('firstWorkingMinute', () => {
  it('is its own answer for every minute a window covers, edges included', () => {
    for (const minute of [t('07:00'), t('08:00'), t('13:59'), t('15:30'), t('20:29')]) {
      expect(firstWorkingMinute(WINDOWS, minute), `at ${minute}`).toBe(minute);
    }
  });

  it('answers 15:30 for every minute of the break, first and last', () => {
    // 14:00 is the exclusive END of the first window and before the start of the second, so it
    // belongs to neither — which is what let a drop released there be stored uncut, running
    // straight through the break. Every minute up to 15:29 is the same gesture.
    for (const minute of [t('14:00'), t('14:01'), t('15:00'), t('15:29')]) {
      expect(firstWorkingMinute(WINDOWS, minute), `at ${minute}`).toBe(t('15:30'));
    }
  });

  it('answers the first minute of the day for anything above it', () => {
    expect(firstWorkingMinute(WINDOWS, t('06:59'))).toBe(t('07:00'));
    expect(firstWorkingMinute(WINDOWS, 0)).toBe(t('07:00'));
  });

  it('leaves a minute alone when no window ever covers it again', () => {
    // Past the end of the day, and on a day whose afternoon is switched off, where the hole
    // runs to midnight. There is no later working minute to offer, so the answer belongs to
    // `dayEndMinutes` and its callers — the drop rolls to another day, or the write refuses.
    expect(firstWorkingMinute(WINDOWS, t('20:30'))).toBe(t('20:30'));
    expect(firstWorkingMinute(WINDOWS, t('23:00'))).toBe(t('23:00'));
    const morningOnly = manualWindowsOf([PERIODS[0]], 60, 60);
    expect(firstWorkingMinute(morningOnly, t('14:59'))).toBe(t('14:59'));
    expect(firstWorkingMinute(morningOnly, t('15:00'))).toBe(t('15:00'));
    expect(firstWorkingMinute(morningOnly, t('18:00'))).toBe(t('18:00'));
  });

  it('has no window to offer on a day with none at all', () => {
    expect(firstWorkingMinute([], t('14:00'))).toBe(t('14:00'));
  });

  it('does not depend on the order the windows come in', () => {
    expect(firstWorkingMinute([...WINDOWS].reverse(), t('14:30'))).toBe(t('15:30'));
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

  it('starts a row that begins inside the break at the next working minute', () => {
    // A row whose start is not working time begins where the shop can start, so it reaches
    // exactly as far as one released at 15:30 does. It used to be held inside the band —
    // `14:30-15:30` and nothing after it — which read the row as sitting in the lunch break
    // and is what let 2 h released at 14:00 be measured, and stored, as `14:00-16:00`.
    expect(reachableRuns(WINDOWS, t('14:30'), t('20:30'))).toEqual([
      { startMinutes: t('15:30'), endMinutes: t('20:30') },
    ]);
    // Every minute of the band gives the same answer, first and last included.
    for (const minute of [t('14:00'), t('15:00'), t('15:29'), t('15:30')]) {
      expect(reachableRuns(WINDOWS, minute, t('20:30')), `released at ${minute}`).toEqual([
        { startMinutes: t('15:30'), endMinutes: t('20:30') },
      ]);
    }
    // And the last minute of the morning is still the morning's.
    expect(reachableRuns(WINDOWS, t('13:59'), t('20:30'))).toEqual([
      { startMinutes: t('13:59'), endMinutes: t('14:00') },
      { startMinutes: t('15:30'), endMinutes: t('20:30') },
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

// ---------------------------------------------------------------------------
// The end of the day, and the two conversions stated over it
// ---------------------------------------------------------------------------
//
// Invariant 3 of the battery: no stored row runs past the end of its day. Three call
// sites used to draw that line at midnight — a drop, a bottom-edge resize and the
// scissors — so all three are now stated over these three functions.

describe('dayEndMinutes', () => {
  it('is the end of the last manual window, margin included', () => {
    expect(dayEndMinutes(WINDOWS)).toBe(t('20:30'));
    expect(dayEndMinutes(PERIODS)).toBe(t('19:30'));
    expect(dayEndMinutes(manualWindowsOf(PERIODS, 60, 0))).toBe(t('19:30'));
  });

  it('falls back to midnight on a day with no windows at all', () => {
    expect(dayEndMinutes([])).toBe(1440);
  });
});

describe('clockEndOf', () => {
  it('is the end of the last row a net-minute stretch is stored as', () => {
    // The owner's own worked example: 6 h from 10:00 is 10:00-14:00 plus 15:30-17:30.
    expect(clockEndOf(WINDOWS, t('10:00'), 360)).toBe(t('17:30'));
    // Inside one window it is plain arithmetic.
    expect(clockEndOf(WINDOWS, t('08:00'), 240)).toBe(t('12:00'));
    // Exactly the day's last minute.
    expect(clockEndOf(WINDOWS, t('09:00'), 600)).toBe(t('20:30'));
  });

  it('reports the minutes that run past the end of the day rather than hiding them', () => {
    // The drop that stored 13:15-14:00 + 15:30-20:45 (invariant 3, rank 1).
    expect(clockEndOf(WINDOWS, t('13:15'), 360)).toBe(t('20:45'));
    expect(clockEndOf(WINDOWS, t('15:30'), 720)).toBe(t('20:30') + 420);
  });

  it('reads a row that STARTS in the break from the next working minute, as the splitter does', () => {
    // 6 h aimed at the lunch band starts at 15:30 and therefore ends at 21:30 — past the end
    // of the day, which is the caller's problem and not this function's. It used to answer
    // 20:00, the reading that stored `14:00 +360m` as one row through the break.
    expect(clockEndOf(WINDOWS, t('14:00'), 360)).toBe(t('15:30') + 360);
    expect(clockEndOf(WINDOWS, t('14:30'), 60)).toBe(t('16:30'));
    // The whole band answers the same, so no minute of it is a different gesture.
    for (const minute of [t('14:00'), t('15:00'), t('15:29'), t('15:30')]) {
      expect(clockEndOf(WINDOWS, minute, 120), `from ${minute}`).toBe(t('17:30'));
    }
    // Past the last window there IS no next working minute (a margin the owner has since set
    // to 0, or an afternoon switched off), so the overrun is reported rather than moved.
    expect(clockEndOf(manualWindowsOf(PERIODS, 60, 0), t('19:30'), 60)).toBe(t('20:30'));
    expect(clockEndOf(manualWindowsOf([PERIODS[0]], 0, 0), t('16:00'), 60)).toBe(t('17:00'));
  });
});

describe('latestStartFor', () => {
  it('leaves room for the WHOLE stretch, counting the lunch break it will cross', () => {
    expect(latestStartFor(WINDOWS, 360)).toBe(t('13:00'));
    expect(latestStartFor(WINDOWS, 600)).toBe(t('09:00'));
    expect(latestStartFor(WINDOWS, 60)).toBe(t('19:30'));
    expect(latestStartFor(WINDOWS, 300)).toBe(t('15:30'));
  });

  it('agrees with clockEndOf at the boundary, on both sides of it', () => {
    for (const net of [15, 60, 135, 300, 360, 555, 600, 720]) {
      const start = latestStartFor(WINDOWS, net);
      expect(clockEndOf(WINDOWS, start, net), `net ${net}`).toBeLessThanOrEqual(t('20:30'));
      expect(clockEndOf(WINDOWS, start + 15, net), `net ${net} + a quarter`).toBeGreaterThan(t('20:30'));
    }
  });

  it('gives back the first window when the stretch is longer than the whole day', () => {
    expect(latestStartFor(WINDOWS, 20 * 60)).toBe(t('07:00'));
  });
});
