/**
 * How a drop's hours divide across the days, as arithmetic
 * the ghost can run before the release: 6 h into a 4 h afternoon is 4 h here and 2 h tomorrow.
 * `compose` imports `takeableFrom` from here so the engine and the preview cannot disagree about
 * the quarter-hour floor. It is NOT the reflow: it answers only how far these hours reach given
 * where the work in front of them ends, and where the rest goes.
 */

import type { WorkPeriod } from '../types';
import { MIN_ROW_MINUTES } from './validation';

/** An interval that holds something. A block, a gap — whatever the caller is excluding. */
export interface SpillInterval {
  startMinutes: number;
  durationMinutes: number;
}

/** A run of free minutes inside ONE period: what a single row could occupy. */
export interface SpillStretch {
  startMinutes: number;
  endMinutes: number;
}

/**
 * How much of `remaining` a stretch of `available` free minutes may take, so that neither the row
 * it makes nor the hours it leaves behind is under a quarter of an hour. Zero means "step over this
 * stretch".
 *
 * `lastResort` stops the floor becoming a refusal — `compose` walks the horizon a second time with
 * it off rather than roll a save back. THE GHOST ALWAYS ASKS WITH IT ON: a preview has no
 * transaction to save, and where the engine falls back it stores MORE here, never less.
 */
export function takeableFrom(available: number, remaining: number, lastResort: boolean): number {
  const chunk = Math.min(available, remaining);
  if (chunk >= remaining) return chunk;
  if (remaining < MIN_ROW_MINUTES) return chunk;
  if (remaining < 2 * MIN_ROW_MINUTES) return lastResort ? chunk : 0;
  if (chunk < MIN_ROW_MINUTES) return lastResort ? chunk : 0;
  return Math.min(chunk, remaining - MIN_ROW_MINUTES);
}

/**
 * The free runs of a day from `fromMinutes` onward — the periods with `occupied` taken out, one
 * entry per period so no stretch ever spans a break: a stretch across the comida is ONE stretch to
 * the arithmetic and TWO rows on the clock, so a piece of it could be a legal 20 minutes and store
 * a 10-minute row (harness seed 275). Measured over the PERIODS, never the manual windows, because
 * auto-fill does not enter a margin.
 */
export function freeStretchesFrom(
  periods: readonly WorkPeriod[],
  occupied: readonly SpillInterval[],
  fromMinutes: number,
): SpillStretch[] {
  const blocked = mergeIntervals(occupied);
  const stretches: SpillStretch[] = [];

  for (const period of periods) {
    let cursor = Math.max(period.startMinutes, fromMinutes);
    for (const range of blocked) {
      if (cursor >= period.endMinutes) break;
      if (range.endMinutes <= cursor) continue;
      if (range.startMinutes >= period.endMinutes) break;
      if (range.startMinutes > cursor) {
        stretches.push({ startMinutes: cursor, endMinutes: Math.min(range.startMinutes, period.endMinutes) });
      }
      cursor = Math.max(cursor, range.endMinutes);
    }
    if (cursor < period.endMinutes) {
      stretches.push({ startMinutes: cursor, endMinutes: period.endMinutes });
    }
  }

  return stretches;
}

/**
 * Where the drop's hours really begin on the day they were released on: the end of the work in
 * front of them, which is the start of the free run the aim sits in. The rank SENT is still the raw
 * minute, but the engine places the item at its cursor — 6 h released at 16:00 into an afternoon
 * free from 15:30 is stored from 15:30, and drawn from 16:00 the label would print two numbers the
 * save contradicts. Measured against everything on the day, gaps and movable rows alike: what is in
 * front of the aim stays in front of it. An aim inside an occupied interval is left as it came.
 */
export function fillStartFor(
  periods: readonly WorkPeriod[],
  occupied: readonly SpillInterval[],
  aimMinutes: number,
): number {
  const holding = freeStretchesFrom(periods, occupied, 0).find(
    (stretch) => aimMinutes >= stretch.startMinutes && aimMinutes <= stretch.endMinutes,
  );
  return holding === undefined ? aimMinutes : holding.startMinutes;
}

/** One day as a landing place for hours that fill and overflow. */
export interface SpillDay {
  date: string;
  /** Auto-fill's view of the day. A margin is not in it, and never receives overflow. */
  periods: readonly WorkPeriod[];
  /**
   * What nothing will move out of the way: the day's GAPS and its LOCKED rows. Ordinary work is
   * deliberately absent — it is behind the drop in the queue now, so the reflow lays it out after
   * these hours rather than making them wait.
   */
  immovable: readonly SpillInterval[];
  /**
   * The day's stop-line for auto-fill: `plannableMinutes` less whatever the work in FRONT of the
   * drop has already spent of it, all of it on a day the hours arrive at from above. Zero closes it.
   */
  budgetMinutes: number;
  /**
   * The first minute these hours may take on this day: the fill start on the day of the release
   * (`fillStartFor`), omitted on every day after it, where the cursor reaches the day fresh.
   */
  fromMinutes?: number;
}

/** One row the drop's hours will be stored as, on one day. */
export interface SpillPiece {
  date: string;
  startMinutes: number;
  durationMinutes: number;
}

export interface DropSpill {
  /** The rows, in calendar order. Empty when not one of the days offered can hold a row. */
  pieces: SpillPiece[];
  /**
   * Hours with nowhere left on the days offered. The ghost can only walk the week on screen, so
   * this normally means "they carry on into a week you are not looking at".
   */
  beyondMinutes: number;
}

/**
 * The rows a drop's hours will be stored as, day by day: fill what this day has left, carry the
 * rest to the next day that can take it. `days` is the release day followed by the days the
 * overflow may use, and the CALLER decides which those are.
 *
 * Forward only, one visit per stretch, so a stretch whose take `takeableFrom` cut short leaves the
 * rest of itself free rather than being offered the sliver it just refused: that is the
 * no-backfill rule, and why this reads as a transcription of the engine's `planTake`.
 */
export function planDropSpill(input: {
  days: readonly SpillDay[];
  /** The whole gesture's net working minutes. */
  durationMinutes: number;
}): DropSpill {
  const pieces: SpillPiece[] = [];
  let remaining = input.durationMinutes;

  for (const day of input.days) {
    if (remaining <= 0) break;
    let budget = day.budgetMinutes;
    if (budget <= 0) continue;

    for (const stretch of freeStretchesFrom(day.periods, day.immovable, day.fromMinutes ?? 0)) {
      if (remaining <= 0 || budget <= 0) break;
      const space = Math.min(stretch.endMinutes - stretch.startMinutes, budget);
      if (space <= 0) continue;
      const minutes = takeableFrom(space, remaining, false);
      if (minutes <= 0) continue;
      pieces.push({ date: day.date, startMinutes: stretch.startMinutes, durationMinutes: minutes });
      remaining -= minutes;
      budget -= minutes;
    }
  }

  return { pieces, beyondMinutes: remaining };
}

/** One day's share of a drop: the hours, whatever number of rows they are stored as. */
export interface SpillDayTotal {
  date: string;
  minutes: number;
}

/**
 * The pieces as a SENTENCE reads them — one entry per DAY, so «4 h el lunes · 2 h el martes» says
 * two things rather than three when the Monday share is cut in half by a lock. Read by the ghost's
 * label and by the notice afterwards, which must count the days the same way.
 */
export function spillByDay(pieces: readonly SpillPiece[]): SpillDayTotal[] {
  const totals: SpillDayTotal[] = [];
  for (const piece of pieces) {
    const last = totals[totals.length - 1];
    if (last !== undefined && last.date === piece.date) {
      last.minutes += piece.durationMinutes;
      continue;
    }
    totals.push({ date: piece.date, minutes: piece.durationMinutes });
  }
  return totals;
}

/** The occupied intervals, overlaps folded together, in order. */
function mergeIntervals(intervals: readonly SpillInterval[]): SpillStretch[] {
  const sorted = intervals
    .map((interval) => ({
      startMinutes: interval.startMinutes,
      endMinutes: interval.startMinutes + interval.durationMinutes,
    }))
    .sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);

  const merged: SpillStretch[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.startMinutes <= last.endMinutes) {
      last.endMinutes = Math.max(last.endMinutes, range.endMinutes);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}
