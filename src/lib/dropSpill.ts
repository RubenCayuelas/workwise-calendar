/**
 * HOW A DROP'S HOURS DIVIDE ACROSS THE DAYS — *Fill and Overflow, Always*, as arithmetic
 * the ghost can run before the mouse is released.
 *
 * Since 2026-08-17 work fills what is left of the day and the remainder overflows to the
 * next day it can use, whoever placed it. That deleted the drag layer's whole vocabulary of
 * refusal — «6 h no pueden empezar después de las 13:00» about a release the server accepts
 * — and left the preview with nothing to say about the one thing that really happens now:
 * 6 h released into a 4 h afternoon is **4 h here and 2 h tomorrow**. Two rectangles, not
 * one refusal.
 *
 * WHY IT LIVES ON ITS OWN, next to `dropSegments.ts` and `dropSlide.ts` and for the same
 * reason: TWO CALLERS NEED THE SAME ANSWER AND NEITHER MAY GUESS IT.
 *
 * - `compose` (src/lib/composition.ts) imports `takeableFrom`, which is the quarter-hour
 *   floor at the one place splitting happens. It used to live inside the engine, and a
 *   preview that re-derived it would have drawn the ten-minute rows the floor exists to
 *   prevent.
 * - the drag ghost (src/components/calendar/WeekGrid.tsx) draws the division while the
 *   pointer is still down.
 *
 * WHAT IT IS NOT: the reflow. The engine lays the WHOLE QUEUE out, so it alone knows where
 * an item ends up once the rows in front of it have moved. This answers the narrower
 * question the ghost can honestly ask — *given where the work in front of this drop ends,
 * how far down the day do these hours reach, and where does the rest go* — which is what
 * makes the numbers on the label right in the case the owner reported. Where the reflow
 * disagrees it is because it found room EARLIER (the drop is a rank; `notices.dropSettles`
 * is what says so afterwards), never because it stored a shape this did not draw.
 *
 * Pure arithmetic over integer minutes: no clock, no database, no React.
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
 * HOW MUCH OF `remaining` A STRETCH OF `available` FREE MINUTES MAY TAKE, so that neither
 * the row it makes nor the hours it leaves behind is shorter than a quarter of an hour.
 * Zero means "step over this stretch".
 *
 * This is *The Calendar Sits On The Quarter Hour* applied at the one place splitting now
 * happens, and it is the sharp edge of "fill and overflow": once a day is allowed to take
 * *part* of an item, the arithmetic can leave any number of minutes over, and a 10-minute
 * hole must not become a 10-minute row — on screen that is a nameless two-pixel stripe
 * (`MIN_LABEL_HEIGHT`).
 *
 * The answers, in the order they are asked:
 *
 * 1. THE WHOLE REST FITS HERE. Nothing is left over, so nothing can be a sliver.
 * 2. THE REST IS ITSELF UNDER A QUARTER OF AN HOUR. It cannot be a row wherever it goes, so
 *    it is DRAWN rather than carried around for ever.
 * 3. THE REST IS A ROW BUT NOT TWO. There is no split of it that avoids a sliver, so it
 *    goes on WHOLE and this stretch keeps its minutes.
 * 4. THIS STRETCH CANNOT HOLD A ROW. Stepped over like an obstacle: the hours go on to the
 *    next run, the next day, and the free minutes stay free. This is the answer the old
 *    "does the whole item fit here" question used to give for free, and it is the one the
 *    new engine has to make explicitly.
 * 5. OTHERWISE, LEAVE A FULL QUARTER OF AN HOUR for the hours that carry on.
 *
 * `lastResort` is what stops 3 and 4 becoming a refusal. An item the cursor keeps stepping
 * over ends in `horizon-exceeded`, which rolls the WHOLE save back, and a short row on
 * screen is far better than that — so `compose` walks the horizon once with the floor on
 * and, only if the hours still have nowhere to go, once more with it off. On a calendar
 * whose quantities are all on the quarter hour the second pass never runs and answers 1 and
 * 5 are the only ones reached, 5 being a no-op.
 *
 * THE GHOST ASKS IT WITH THE FLOOR ON, always: the second pass exists to save a whole
 * transaction from rolling back, and a preview has no transaction to save. Drawing the
 * common answer is right — and where the engine does fall back, it stores MORE here than
 * the ghost drew, never less.
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
 * THE FREE RUNS OF A DAY, from `fromMinutes` onward — the periods with `occupied` taken
 * out, one entry per period so no stretch ever spans a break.
 *
 * The clock-space twin of the engine's `freeRangesOf` + `splitAtBreaks`, and the cut at the
 * break is the same load-bearing detail: a stretch spanning the comida is ONE stretch to
 * the arithmetic and TWO rows on the clock, so a piece taken from it could be a legal 20
 * minutes and store a 10-minute row (the harness's seed 275). Here every stretch lies
 * inside one period, so a stretch, a piece and a stored row are the same thing.
 *
 * MEASURED OVER THE PERIODS, never the manual windows: auto-fill does not enter a visual
 * margin, so hours the reflow carries may not be drawn in one.
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
 * WHERE THE DROP'S HOURS REALLY BEGIN ON THE DAY THEY WERE RELEASED ON: the end of the work
 * in front of them, which on a laid-out calendar is the start of the free run the aim sits
 * in.
 *
 * The rank is the raw minute the owner released on — that is what is SENT, because a rank is
 * an ordering between neighbours. But the engine does not store the rank: it places the item
 * at its cursor, and the cursor is wherever the work ranked in front of it ended. So a 6 h
 * drop released at 16:00 into an afternoon that is free from 15:30 is stored from **15:30**,
 * takes 4 h there and carries 2 h on. Drawn from 16:00 instead, the same drop would have
 * printed «3,5 h el lunes · 2,5 h el martes» — two numbers the save contradicts.
 *
 * MEASURED AGAINST EVERYTHING ON THE DAY, gaps and movable rows alike, which is the
 * difference between this question and the ROOM below. Everything currently in front of the
 * aim stays in front of it (strict queue order), so it is what the pull-back stops at;
 * everything after it reflows behind the drop, so it is not room the drop loses.
 *
 * An aim inside an occupied interval is left exactly as it came: there the drop cuts the row
 * it landed in, and its hours really do start on that minute. So is an aim no period covers
 * — a margin, or the comida — which `freeStretchesFrom` then reads forward from anyway.
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
   * What nothing will move out of the way: the day's GAPS and its LOCKED rows. Ordinary
   * work is deliberately absent — it is behind the drop in the queue now, so the reflow
   * lays it out after these hours rather than making them wait.
   */
  immovable: readonly SpillInterval[];
  /**
   * The day's stop-line for auto-fill: `plannableMinutes` on the release day less whatever
   * the work in FRONT of the drop has already spent of it, the whole of it on a day the
   * hours arrive at from above. Zero says the day is closed to the engine.
   */
  budgetMinutes: number;
  /**
   * The first minute these hours may take on this day. The fill start on the day of the
   * release (`fillStartFor`); omitted on every day after it, where the hours arrive at the
   * top of the periods because the cursor reaches the day fresh.
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
   * Hours with nowhere left on the days offered. The ghost can only walk the week on
   * screen, so this is normally "they carry on into a week you are not looking at" rather
   * than "they do not fit anywhere".
   */
  beyondMinutes: number;
}

/**
 * THE ROWS A DROP'S HOURS WILL BE STORED AS, day by day: fill what this day has left,
 * carry the rest to the next day that can take it.
 *
 * `days` is the release day followed by the days the overflow may use, in calendar order,
 * and the caller decides which those are — the weekend, a closed day and the past are not
 * among them, and neither is the Friday colchón, which takes overflow only from work that
 * grew (`acceptsItem`). Forward only, one visit per stretch, so a stretch whose take
 * `takeableFrom` cut short leaves the rest of itself free instead of being offered the
 * sliver it just refused. That is the no-backfill rule, and it is why this reads as a
 * transcription of the engine's `planTake`.
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
 * THE PIECES AS A SENTENCE READS THEM — one entry per DAY, so «4 h el lunes · 2 h el martes»
 * says two things rather than three when the Monday share is cut in half by a lock.
 *
 * Read by the ghost's label and by the notice afterwards, which is why it is here and not in
 * either: the two must count the days the same way or the drag and the toast will disagree
 * about what just happened.
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
