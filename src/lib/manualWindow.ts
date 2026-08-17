/**
 * The two views of one day, derived in one place.
 *
 * The engine has always known a day as its **periods** — `08:00-14:00` and
 * `15:30-19:30` — because those are the hours auto-fill may book. A HAND action needs
 * a wider view: CLAUDE.md's visual margins "accept manual drag-drop only", so an hour
 * of margin at either end is time the owner may use and the engine may not.
 *
 * That wider view is a **manual window**: the periods PLUS the margins, fused wherever
 * they touch. On the documented shift it is `07:00-14:00` and `15:30-20:30`, so the
 * lunch break stays the only hole in the day and nothing about segmentation changes.
 *
 *     periods        08:00 ──────── 14:00   15:30 ──────── 19:30
 *     manual window  07:00 ──────────────── 15:30 ──────────────── 20:30
 *                    ^ margin                                ^ margin
 *
 * WHY IT IS ONE MODULE AND NOT A FLAG PASSED AROUND. Three defects the owner reported
 * were the same defect: a resize stopped at its period's end, a drop into a margin was
 * pulled back out, and margin time was unreachable by hand — each one a place where the
 * only view available was the engine's. Scattering `if (isMargin)` through the drag
 * layer, the engine and the scheduler would fix them one at a time and leave the next
 * reader free to add a rule to one view and forget the other. So both views are derived
 * HERE, from `DayShape` (see `dayShapeFromSettings`), travel together on `DayConfig` and
 * `WeekDay`, and every rule is stated over one of them explicitly:
 *
 * - AUTO-FILL and the capacity stop-line read `periods`, and only `periods`. The margins
 *   are invisible to `compose`, which is what keeps auto-fill out of them.
 * - A HAND ACTION — a drop, a resize, the scissors — reads `manualWindows`.
 *
 * Pure integer-minute arithmetic: no clock, no database, no React, so the browser can
 * have it as cheaply as the server can.
 */

import { MINUTES_PER_DAY } from './dates';
import type { WorkPeriod } from '../types';

/**
 * One day as both halves of the app need it. `DayConfig` and `WeekDay` satisfy it, so a
 * function that takes hand gestures can ask for exactly this much of a day.
 */
export interface DayWindows {
  /** Auto-fill's view: the working periods, morning first. */
  readonly periods: readonly WorkPeriod[];
  /** A hand action's view: the periods plus the visual margins, fused where they touch. */
  readonly manualWindows: readonly WorkPeriod[];
}

/**
 * The periods widened by the visual margins — the top margin before the first period,
 * the bottom margin after the last — and fused wherever the result touches or overlaps.
 *
 * Fusing matters for two real configurations: a shift with no lunch at all
 * (`period2Start === period1End`) becomes ONE window, so nothing is ever cut in the
 * middle of it; and a margin wide enough to reach the neighbouring period cannot produce
 * two overlapping windows. A day with no periods (a closed day, or a broken
 * configuration) has no manual window either — there is nothing for a margin to hang off.
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
 * THE FIRST MINUTE AT OR AFTER `minute` THAT `intervals` ACTUALLY COVER — the answer to
 * "the owner aimed HERE; where can work really start?"
 *
 * A minute inside a window is its own answer, so this is a no-op for every ordinary
 * gesture. It exists for the minutes that are not: **the lunch break**, where a gesture
 * aimed at a slot that does not exist and the honest reading is the next one that does.
 * On the documented shift 14:00, 15:00 and 15:29 all mean 15:30, which is already exactly
 * what the same band means to a RESIZE — `netMinutesBetween` counts no working minutes in
 * there, so all three commit the same duration.
 *
 * WHY IT IS NOT A CLAMP AND NOT A REFUSAL. Left as it came, a start in the break makes a
 * stored row claim work in time the shop cannot work: 2 h released at 14:00 was saved as
 * ONE row `14:00 +120m -> 16:00`, ninety minutes of which is lunch, straddling the break
 * that the data model says no stored row may cross. Refusing instead would answer a plain
 * gesture — "put it after lunch" — with an error about a minute.
 *
 * `minute` IS RETURNED UNCHANGED WHEN NO WINDOW EVER COVERS IT AGAIN: past the end of the
 * day, and on a day whose afternoon is switched off, where the hole after the last window
 * runs to midnight. There is no later working minute to offer, so the answer belongs to
 * `dayEndMinutes` and its callers — the drop rolls to the next day, or the write path
 * refuses — and inventing a start here would hide that from them.
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

/**
 * Minutes of `intervals` inside `[from, to)`. Zero across the lunch break and across a
 * margin when `intervals` are the periods; zero only across the lunch break when they
 * are the manual windows. That difference is the whole point of the two views.
 */
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

/** Total minutes of `intervals`. */
export function netMinutesOf(intervals: readonly WorkPeriod[]): number {
  let total = 0;
  for (const interval of intervals) total += Math.max(0, interval.endMinutes - interval.startMinutes);
  return total;
}

/**
 * The clock a row starting at `startMinutes` may grow over, as intervals — the answer to
 * "how long can the owner drag this bottom edge, and which minutes count".
 *
 * From inside a window it is that window from `startMinutes` on, PLUS every later
 * window: a row starting at 10:00 can be dragged to 17:30 and the lunch break in between
 * contributes nothing, which is exactly the owner's worked example.
 *
 * FROM INSIDE THE BREAK IT IS THE WINDOWS AFTER IT, because that is where the row itself
 * starts: `firstWorkingMinute` is the one reading of a non-working start, and this function
 * has to give the same one `segmentDroppedRow` does or `clockEndOf` — which is built on it,
 * and which the end-of-day guard and the drop's landing both consult — would describe a row
 * the write path stores somewhere else. It used to return the HOLE ALONE, up to the next
 * window's start, which read the row as sitting in the lunch band and is what let a 2 h
 * release at 14:00 be measured (and stored) as `14:00-16:00`.
 *
 * PAST THE LAST WINDOW there is no later working minute, so it is that hole alone and
 * `endOfDayMinutes` closes it (the axis's own end). A row stranded out there by a settings
 * change keeps its hours and can still be shortened; it can never be grown.
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
 * THE END OF THE DAY FOR EVERY HAND GESTURE: the end of the last manual window.
 *
 * CLAUDE.md states the line twice — the data model's "a stored block never straddles a
 * non-working interval (lunch break, END OF DAY)", and *Block Resize*'s "it stops at the
 * end of the day's last manual window". Before this existed each call site drew its own
 * line and three of them drew it at MIDNIGHT, so a drop, a bottom-edge drag and the
 * scissors could all store a row hanging below the grid's own last rule (20:45, 21:30,
 * 23:00 on the documented shift).
 *
 * A day with no windows at all (a shape with no periods) falls back to midnight: there is
 * no last window to stop at, and refusing every row on such a day would be worse than
 * the guard it replaces.
 */
export function dayEndMinutes(manualWindows: readonly WorkPeriod[]): number {
  let end = 0;
  for (const window of manualWindows) end = Math.max(end, window.endMinutes);
  return end === 0 ? MINUTES_PER_DAY : end;
}

/**
 * The CLOCK minute a row of `netMinutes` starting at `startMinutes` ends at — the end of
 * the LAST row it is stored as.
 *
 * `duration` is net working time, so this is the one conversion that turns a gesture's
 * number back into the geometry it will occupy: 6 h at 13:15 reaches 20:45, because the
 * 45 minutes before lunch and the 5 h after it leave a quarter of an hour to put
 * somewhere.
 *
 * It agrees with `segmentDroppedRow` by construction, and that agreement is load-bearing:
 * both read a non-working start through `firstWorkingMinute`, so 2 h at 14:00 ends at
 * 17:30 here and is stored as `15:30-17:30` there. The two would otherwise disagree by the
 * whole break, and the end-of-day guard, the drag's clamp and the drop's landing all decide
 * from this number what the write path will do with that one.
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
  // More minutes than the day has left: they run past the end of it, which is what the
  // callers refuse or clamp. Reported rather than hidden.
  return end + remaining;
}

/**
 * The LATEST start a row of `netMinutes` may have and still end inside the day.
 *
 * The drag layer's clamp is stated over this rather than over `axisEnd − duration`, which
 * is the arithmetic it used to use and which mixes two units: `duration` is NET working
 * minutes while the axis is CLOCK minutes, so a 6 h unit was allowed to start at 13:15,
 * where it needs 7 h 30 of clock. On the documented shift the true answer is 13:00.
 *
 * Falls back to the first window's start when the row is longer than the whole day's
 * manual time — there is no legal start then, and the caller (a merge, over HTTP) refuses
 * it rather than storing it.
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
 * `startMinutes` — so the two are one stretch: touching rows, or the two halves around
 * the lunch break, and never two rows with real free time between them.
 *
 * One predicate for both sides of the app: the grid groups a unit with it and the resize
 * finds the stretch it is sizing with it, so a unit on screen and a stretch on the server
 * can never disagree about where one ends.
 */
export function adjacentInWindows(
  manualWindows: readonly WorkPeriod[],
  endMinutes: number,
  startMinutes: number,
): boolean {
  return startMinutes >= endMinutes && netMinutesBetween(manualWindows, endMinutes, startMinutes) === 0;
}

/**
 * The smallest amount of manual-only time a hand action can be ASKING for.
 *
 * A drop writes a queue RANK, and a rank that ties with an existing row is nudged by a
 * single minute (`rankFor`) — so "put this at the very top of Monday" arrives as 07:59 when
 * 08:00 is taken. One minute of margin is not a request for the margin; it is a tie-break.
 * The gesture's own resolution is a quarter of an hour (`SNAP_MINUTES` in the drag layer,
 * held equal to this by a test), so that is where a request begins.
 */
export const MIN_MANUAL_ONLY_MINUTES = 15;

/** Minutes in `segments` that the day's PERIODS do not cover: margin and lunch time. */
export function manualOnlyMinutes(
  periods: readonly WorkPeriod[],
  segments: readonly { startMinutes: number; durationMinutes: number }[],
): number {
  let total = 0;
  for (const segment of segments) {
    total +=
      segment.durationMinutes -
      netMinutesBetween(periods, segment.startMinutes, segment.startMinutes + segment.durationMinutes);
  }
  return total;
}

/**
 * True when `segments` ask for a real amount of time the day's PERIODS do not cover — in
 * practice a VISUAL MARGIN. The grid draws exactly that time grey and labels it "solo
 * arrastre manual".
 *
 * The lunch band is drawn the same grey but is no longer reachable this way by a drop or a
 * resize: `segmentDroppedRow` lays both out from `firstWorkingMinute`, so their segments start
 * inside a period. What can still score break minutes here is a segment the segmenter returned
 * UNCUT because its tail would pass midnight — an over-long RUN — which is one of the three
 * things CLAUDE.md's Open Decision 13 deliberately leaves feeding on that number.
 *
 * It is what decides that a hand action has to PADLOCK its row: the engine's index space
 * has no margin minutes in it, so a row the reflow still owns would be pulled straight
 * back into the periods — either moved, or thrown onto the next day when the hours no
 * longer fit there. That is exactly why the margins were configurable and unusable. The
 * padlock is the app's one answer to "this does not move", it is drawn on the row, and it
 * comes off by being pressed.
 */
export function usesManualOnlyTime(
  periods: readonly WorkPeriod[],
  segments: readonly { startMinutes: number; durationMinutes: number }[],
): boolean {
  return manualOnlyMinutes(periods, segments) >= MIN_MANUAL_ONLY_MINUTES;
}
