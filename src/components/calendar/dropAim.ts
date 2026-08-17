/**
 * WHERE A DROP IS REALLY AIMED — the two rules that turn a pixel under the pointer into a
 * place on the calendar, both decided with the owner on 2026-08-14 and both pure.
 *
 * They exist because the raw minute under the pointer was never what the owner meant:
 *
 * 1. THIRDS (`aimAtThirds`). Over another row, the upper third means "before this one",
 *    the lower third "after it", the middle third "cut it here". It replaces aiming at an
 *    exact minute, which asked the owner for a precision a mouse on a shop PC does not
 *    have and produced the sliver rows: a hair below a row's start ranked the drop one
 *    minute after it and cut the row one minute in (`Beta 08:00-08:01`). With three
 *    targets per row the two halves of a snap step can no longer give opposite answers,
 *    and — because the ghost previews the real outcome — hovering the middle third shows
 *    the row actually splitting, so the rule needs no explaining.
 *
 * 2. THE NEXT DAY (`resolveDropDay`). Aiming below what the day can still hold means the
 *    day after. The owner, on being shown the old behaviour (refuse the drop, freeze the
 *    ghost at the lowest point that fits): «Que se rechaza, de qué friki. Pasa al
 *    siguiente día. ¿Sabes cómo funciona un calendario?» They are right — in any calendar
 *    aiming past the end of a day means the next one — and the ghost moves to that column
 *    while the pointer is still down, so the release is never a surprise.
 *
 * WHY THE ROLL IS ONLY OFFERED ON A DAY THE ENGINE LAYS OUT. "The next day the engine
 * would use" is only a meaningful answer where the engine chooses anything at all. On the
 * weekend and in the past a drop is a literal placement on a day the owner named on
 * purpose, so moving it to another date would be a bigger surprise than the clamp; there
 * the old behaviour stays, and `DragPreview.clamped` says out loud that the ghost has
 * stopped following the hand.
 *
 * The clamp also stays as the LAST RESORT everywhere: a run longer than any remaining day
 * can hold has no next day to go to, and a drop still has to be legal — the request
 * carries the whole run's duration, and a row that ends past the end of its day is a 409
 * `row-past-day-end`.
 */

import { dropLanding } from '../../lib/dropSlide';
import { clockEndOf, dayEndMinutes } from '../../lib/manualWindow';
import type { WorkPeriod } from '../../types';
import type { WeekDay } from '../../lib/api-client';
import { dayReflowsOn } from './dropEffect';
import { SNAP_MINUTES, clampDropStart, snapTo, type Timeline } from './geometry';

/** A row the aim can be quantised against. `WeekBlock` satisfies it. */
export interface AimRow {
  id: string;
  startMinutes: number;
  durationMinutes: number;
}

/**
 * THE MINUTE THE DROP REALLY MEANS, once the row under it has had its say.
 *
 * Over free time the aim is left exactly as it came — the owner is pointing at the clock
 * and there is nothing to be relative to. Over a row it collapses to one of three
 * answers, which is the whole point: the row is the target, not the minute.
 *
 * | the aim falls in the row's… | it becomes  | and the drop…                          |
 * |-----------------------------|-------------|----------------------------------------|
 * | upper third                 | its START   | goes in BEFORE it; the row stays whole |
 * | middle third                | its MIDDLE  | CUTS it, the tail carries on after     |
 * | lower third                 | its END     | goes in AFTER it                       |
 *
 * A ROW TOO SHORT TO CUT HAS TWO TARGETS, NOT THREE. Under half an hour neither half of a
 * cut could be a legal row (`MIN_ROW_MINUTES` is a quarter of an hour), so the middle
 * third would offer a gesture whose only possible outcome is a sliver — the very thing
 * thirds were adopted to remove. Such a row is split down the middle into "before" and
 * "after" instead.
 *
 * The cut is the row's own MIDPOINT, snapped, and never within a snap step of either end:
 * the owner is choosing a ROW to cut, not a minute to cut it at, and a cut a quarter of an
 * hour from the edge is a sliver by another name.
 */
export function aimAtThirds(
  aimMinutes: number,
  rows: readonly AimRow[],
  snap: number = SNAP_MINUTES,
): number {
  const row = rows.find(
    (candidate) =>
      aimMinutes >= candidate.startMinutes &&
      aimMinutes < candidate.startMinutes + candidate.durationMinutes,
  );
  if (row === undefined) return aimMinutes;

  const span = row.durationMinutes;
  const offset = aimMinutes - row.startMinutes;
  const endMinutes = row.startMinutes + span;

  // No cut is possible here: halves, not thirds.
  if (span < 2 * snap) return offset * 2 < span ? row.startMinutes : endMinutes;

  if (offset * 3 < span) return row.startMinutes;
  if (offset * 3 >= span * 2) return endMinutes;
  return Math.min(
    endMinutes - snap,
    Math.max(row.startMinutes + snap, snapTo(row.startMinutes + Math.round(span / 2), snap)),
  );
}

/**
 * The day and minute a release really resolves to, and how it got there.
 *
 * Named for the ANSWER, not for the day: `DropDay` in src/lib/dropSlide.ts is one of this
 * function's INPUTS — a day the roll may land on — and two exported types with one name
 * and opposite meanings is how the next agent silently wires the wrong one.
 */
export interface AimedDrop {
  date: string;
  startMinutes: number;
  /**
   * The release did not fit on the day it was made and moved to the next day the engine
   * would use. The ghost is drawn on THAT column, so the drop is never a surprise.
   */
  rolled: boolean;
  /**
   * Nowhere later could hold it either, so the start was pulled UP to the last minute
   * that fits. The one case the ghost stops following the pointer — said out loud.
   */
  clamped: boolean;
}

/**
 * AIMING BELOW WHAT THE DAY CAN HOLD MEANS THE NEXT DAY.
 *
 * The run keeps its whole duration in the request, so a release the day cannot hold is not
 * a smaller drop — it is a drop on another day. The next day the engine would use is the
 * next one it writes to at all: not the past, not a closed day, not the weekend. The
 * Friday colchón IS one of them, because overflow from Thursday is exactly what the
 * buffer is for (CLAUDE.md) — and a drop landing there padlocks the run, which the ghost
 * already says in so many words before the release.
 *
 * The rolled drop starts at the next day's FIRST PERIOD, never in its top margin: a margin
 * minute would padlock a run the owner never asked to fix. Landing on that first minute
 * ties with whatever already starts the day, and `rankFor` breaks the tie downwards — so
 * the run ranks after everything on the day it was aimed at and before everything on the
 * day it moved to, which is what "below the bottom of Wednesday" means.
 *
 * WHERE THE ROLL ITSELF COMES FROM: `dropLanding` in src/lib/dropSlide.ts, the same
 * function `moveBlock` and `splitBlock` decide the landing with. It is imported rather
 * than mirrored on purpose — this file and the write path were briefly two
 * implementations of one rule, which is the shape every drift in `dropEffect.ts` has
 * taken. All that is added here is what the SERVER has no opinion about: the clamp, which
 * is a fact about the drag axis, and the two flags the ghost speaks with.
 *
 * THE WALK STOPS AT THE WEEK ON SCREEN. `dayOf` answers "the engine does not lay this out"
 * for any date outside `days`, so a run that no remaining day of this week can hold is
 * clamped and says so, rather than rolling onto a Monday the owner is not looking at. The
 * server would walk a fortnight; it never sees the difference, because a clamped release
 * fits by construction and `dropLanding` returns a fitting release untouched.
 */
export function resolveDropDay(input: {
  /** The week's days in calendar order — the roll walks them forward. */
  days: readonly WeekDay[];
  date: string;
  startMinutes: number;
  /** The whole run's net working minutes: what the request will carry. */
  durationMinutes: number;
  timeline: Timeline;
}): AimedDrop {
  const day = input.days.find((candidate) => candidate.date === input.date);
  if (day === undefined) {
    return { date: input.date, startMinutes: input.startMinutes, rolled: false, clamped: false };
  }

  const landing = dropLanding({
    date: input.date,
    startMinutes: input.startMinutes,
    durationMinutes: input.durationMinutes,
    dayOf: (date) => {
      const candidate = input.days.find((other) => other.date === date);
      if (candidate === undefined) return { periods: [], manualWindows: [], reflows: false };
      return {
        periods: candidate.periods,
        manualWindows: candidate.manualWindows,
        reflows: dayReflowsOn(candidate),
      };
    },
    maxDays: input.days.length,
  });
  if (landing.date !== input.date) {
    return { ...landing, rolled: true, clamped: false };
  }

  // It landed on the day it was released on: either it fitted there, or nothing later
  // could hold it. Only the second needs the clamp, and only the first may keep a start
  // the drag axis would otherwise pull onto itself.
  if (fitsFrom(day.manualWindows, input.startMinutes, input.durationMinutes)) {
    return { date: input.date, startMinutes: input.startMinutes, rolled: false, clamped: false };
  }

  const clamped = clampDropStart(
    day.manualWindows,
    input.startMinutes,
    input.durationMinutes,
    input.timeline,
  );
  return {
    date: input.date,
    startMinutes: clamped,
    rolled: false,
    clamped: clamped < input.startMinutes,
  };
}

/** Does a row of `durationMinutes` net working minutes starting here end inside the day? */
function fitsFrom(
  windows: readonly WorkPeriod[],
  startMinutes: number,
  durationMinutes: number,
): boolean {
  return clockEndOf(windows, startMinutes, durationMinutes) <= dayEndMinutes(windows);
}
