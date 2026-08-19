/**
 * The two views of one day: auto-fill's `periods`, and a hand gesture's wider `manualWindows` (the
 * periods plus the visual margins). Both derived here so a rule cannot be added to one view and
 * forgotten in the other.
 */

import { MINUTES_PER_DAY } from './dates';
import type { WorkPeriod } from '../types';

/** `DayConfig` and `WeekDay` both satisfy it. */
export interface DayWindows {
  /** Morning first. */
  readonly periods: readonly WorkPeriod[];
  /** The periods plus the visual margins, fused where they touch. */
  readonly manualWindows: readonly WorkPeriod[];
}

/**
 * Fusing matters for two real configurations: a shift with no lunch (`period2Start === period1End`)
 * becomes ONE window, and a margin wide enough to reach the neighbouring period must not produce two
 * overlapping ones. No periods means no manual window — there is nothing for a margin to hang off.
 */
export function manualWindowsOf(
  periods: readonly WorkPeriod[],
  marginTopMinutes: number,
  marginBottomMinutes: number,
): WorkPeriod[] {
  if (periods.length === 0) return [];

  const widened = [...periods]
    .sort((a, b) => a.startMinutes - b.startMinutes)
    .map((period) => ({ ...period }));
  const top = Math.max(0, marginTopMinutes);
  const bottom = Math.max(0, marginBottomMinutes);
  widened[0].startMinutes = Math.max(0, widened[0].startMinutes - top);
  const last = widened[widened.length - 1];
  last.endMinutes = Math.min(MINUTES_PER_DAY, last.endMinutes + bottom);

  const fused: WorkPeriod[] = [];
  for (const window of widened) {
    const open = fused[fused.length - 1];
    if (open !== undefined && window.startMinutes <= open.endMinutes) {
      open.endMinutes = Math.max(open.endMinutes, window.endMinutes);
      continue;
    }
    fused.push(window);
  }
  return fused;
}

/**
 * The first minute at or after `minute` that `intervals` cover: a no-op inside a window, and the rule
 * for the lunch break, where 14:00, 15:00 and 15:29 all mean 15:30. Returned UNCHANGED when no window
 * ever covers it again — past the end of the day, or an afternoon switched off — because inventing a
 * start there would hide that from the caller.
 */
export function firstWorkingMinute(intervals: readonly WorkPeriod[], minute: number): number {
  let answer: number | undefined;
  for (const interval of intervals) {
    if (minute >= interval.endMinutes) continue;
    const candidate = Math.max(minute, interval.startMinutes);
    if (answer === undefined || candidate < answer) answer = candidate;
  }
  return answer ?? minute;
}

/** Minutes of `intervals` inside the half-open range `[from, to)`. */
export function netMinutesBetween(
  intervals: readonly WorkPeriod[],
  from: number,
  to: number,
): number {
  if (to <= from) return 0;
  let total = 0;
  for (const interval of intervals) {
    total += Math.max(0, Math.min(interval.endMinutes, to) - Math.max(interval.startMinutes, from));
  }
  return total;
}

export function netMinutesOf(intervals: readonly WorkPeriod[]): number {
  let total = 0;
  for (const interval of intervals) total += Math.max(0, interval.endMinutes - interval.startMinutes);
  return total;
}

/**
 * The clock a row starting at `startMinutes` may grow over: that window from the start on, plus every
 * later one — so 10:00 dragged to 17:30 is 6 h and the break costs nothing. A start inside the break
 * is read through `firstWorkingMinute`, so this and `segmentDroppedRow` describe the same row. Past
 * the last window it is the hole alone, closed by `endOfDayMinutes`.
 */
export function reachableRuns(
  manualWindows: readonly WorkPeriod[],
  startMinutes: number,
  endOfDayMinutes: number,
): WorkPeriod[] {
  const ordered = [...manualWindows].sort((a, b) => a.startMinutes - b.startMinutes);
  const from = firstWorkingMinute(ordered, startMinutes);
  const runs: WorkPeriod[] = [];

  for (const window of ordered) {
    if (window.endMinutes <= from) continue;
    runs.push({ startMinutes: Math.max(window.startMinutes, from), endMinutes: window.endMinutes });
  }

  if (runs.length === 0) {
    return [{ startMinutes: from, endMinutes: Math.max(from, endOfDayMinutes) }];
  }
  return runs;
}

/**
 * The end of the day for every hand gesture: the end of the last manual window. A shape with no
 * periods falls back to midnight — refusing every row on such a day would be worse.
 */
export function dayEndMinutes(manualWindows: readonly WorkPeriod[]): number {
  let end = 0;
  for (const window of manualWindows) end = Math.max(end, window.endMinutes);
  return end === 0 ? MINUTES_PER_DAY : end;
}

/**
 * The CLOCK minute a row of `netMinutes` starting at `startMinutes` ends at: 6 h at 13:15 reaches
 * 20:45. Reads a non-working start through `firstWorkingMinute` exactly as `segmentDroppedRow` does —
 * the guard, the clamp and the drop's landing all decide from this number what the write path will
 * do, so the two may not disagree by the whole break.
 */
export function clockEndOf(
  manualWindows: readonly WorkPeriod[],
  startMinutes: number,
  netMinutes: number,
): number {
  const runs = reachableRuns(manualWindows, startMinutes, MINUTES_PER_DAY);
  let remaining = netMinutes;
  let end = startMinutes;

  for (const run of runs) {
    const from = Math.max(run.startMinutes, startMinutes);
    const room = Math.max(0, run.endMinutes - from);
    if (remaining <= room) return from + remaining;
    remaining -= room;
    end = run.endMinutes;
  }
  // More minutes than the day has left: reported rather than hidden, so callers can refuse or clamp.
  return end + remaining;
}

/**
 * The latest start a row of `netMinutes` may have and still end inside the day. Not
 * `axisEnd − duration`, which mixes net minutes with clock minutes. Falls back to the first window's
 * start when the row is longer than the whole day's manual time: there is no legal start then, and
 * the caller refuses rather than storing it.
 */
export function latestStartFor(
  manualWindows: readonly WorkPeriod[],
  netMinutes: number,
): number {
  const ordered = [...manualWindows].sort((a, b) => a.startMinutes - b.startMinutes);
  if (ordered.length === 0) return 0;

  let needed = netMinutes;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const window = ordered[index];
    const room = Math.max(0, window.endMinutes - window.startMinutes);
    if (needed <= room) return window.endMinutes - needed;
    needed -= room;
  }
  return ordered[0].startMinutes;
}

/**
 * True when nothing workable separates a row ending at `endMinutes` from one starting at
 * `startMinutes` — touching rows, or the two halves around lunch. One predicate for the grid's
 * grouping and the resize's stretch, so screen and server cannot disagree.
 */
export function adjacentInWindows(
  manualWindows: readonly WorkPeriod[],
  endMinutes: number,
  startMinutes: number,
): boolean {
  return startMinutes >= endMinutes && netMinutesBetween(manualWindows, endMinutes, startMinutes) === 0;
}

/**
 * The smallest manual-only time a hand action can be ASKING for: `rankFor` nudges a tying rank by one
 * minute, and one minute of margin is a tie-break rather than a request. Held equal to the drag
 * layer's `SNAP_MINUTES` by a test.
 */
export const MIN_MANUAL_ONLY_MINUTES = 15;

/**
 * The manual-only minutes a DROP is asking for: the ones it must spend before it reaches working
 * hours, and every minute of it when there are no working hours left at all. Minutes past the end of
 * the periods are overflow, not a request for the margin below them.
 */
export function manualOnlyHeadMinutes(
  periods: readonly WorkPeriod[],
  startMinutes: number,
  durationMinutes: number,
): number {
  // No working time at or after the start — a bottom margin, or an afternoon switched off.
  if (netMinutesBetween(periods, startMinutes, MINUTES_PER_DAY) === 0) return durationMinutes;
  const working = firstWorkingMinute(periods, startMinutes);
  return Math.min(durationMinutes, Math.max(0, working - startMinutes));
}

export function startsInManualOnlyTime(
  periods: readonly WorkPeriod[],
  startMinutes: number,
  durationMinutes: number,
): boolean {
  return manualOnlyHeadMinutes(periods, startMinutes, durationMinutes) >= MIN_MANUAL_ONLY_MINUTES;
}
