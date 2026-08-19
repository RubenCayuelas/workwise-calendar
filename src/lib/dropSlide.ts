/**
 * Where a drop really lands when it cannot land exactly where it was released: `firstClearStart`
 * finds the MINUTE and `dropLanding` the DAY, both by walking FORWARD from the release point.
 * Pure integer minutes, imported by the write path and by the drag ghost so the two cannot answer
 * differently. "Immovable" is exactly a GAP and a LOCKED row.
 */

import type { DayRole } from './composition';
import { addDays } from './dates';
import { segmentDroppedRow, overlapsSegments, type DropSegment } from './dropSegments';
import {
  clockEndOf,
  dayEndMinutes,
  firstWorkingMinute,
  startsInManualOnlyTime,
} from './manualWindow';
import type { WorkPeriod } from '../types';

export interface DropSlideInput {
  /**
   * The day's MANUAL WINDOWS: the slid row stays inside one of them, because answering a request
   * for a slot by parking the row in the lunch band would be a stranger answer than the collision.
   */
  windows: readonly WorkPeriod[];
  /**
   * The gaps and the LOCKED rows on the day, in any order. The dragged unit's own rows must not be
   * in here — a row cannot be an obstacle to itself.
   */
  immovable: readonly DropSegment[];
  startMinutes: number;
  /** Net working minutes: the whole unit's, since the whole unit moves as one row. */
  durationMinutes: number;
}

/**
 * The first start, at or after `startMinutes`, whose footprint touches nothing in
 * `immovable` and still ends inside the day. `null` when the day has none.
 */
export function firstClearStart(input: DropSlideInput): number | null {
  const obstacles = [...input.immovable].sort((a, b) => a.startMinutes - b.startMinutes);
  const endOfDay = dayEndMinutes(input.windows);
  let startMinutes = input.startMinutes;

  // Each step clears one obstacle's END, and an obstacle ending at or before the start can never
  // be hit again, so every step is strictly forward and one pass per obstacle is enough.
  for (let step = 0; step <= obstacles.length; step += 1) {
    const footprint = segmentDroppedRow(input.windows, {
      startMinutes,
      durationMinutes: input.durationMinutes,
    });
    const hit = obstacles.find((obstacle) =>
      overlapsSegments(footprint, obstacle.startMinutes, obstacle.durationMinutes),
    );
    if (hit === undefined) {
      return clockEndOf(input.windows, startMinutes, input.durationMinutes) > endOfDay
        ? null
        : startMinutes;
    }
    startMinutes = firstWorkingMinute(input.windows, hit.startMinutes + hit.durationMinutes);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Does the drop keep the minute it was released on?
// ---------------------------------------------------------------------------

export interface DropPin {
  /**
   * The thing being dragged is fixed BY ITSELF, so it lands wherever it is released whatever day
   * that is: a row carrying a padlock, or a GAP, which is fixed occupancy by definition.
   */
  fixed: boolean;
  /** `auto` Mon-Thu, `buffer` Friday, `manual` Sat/Sun. */
  role: DayRole;
  /** The day's WORKING periods: the minutes auto-fill may use, margins excluded. */
  periods: readonly WorkPeriod[];
  /** The periods with the margins fused on: the view a hand action is cut over. */
  manualWindows: readonly WorkPeriod[];
  startMinutes: number;
  /** Net working minutes — the whole unit's, since the whole unit moves as one row. */
  durationMinutes: number;
}

/**
 * Does this drop land literally — keeping the exact minute it was released on, and earning a
 * padlock for it? THE ONE IMPLEMENTATION, read by the write path (`pinsTheRow`), by the drag ghost
 * (`dropPins`) and by `dropLanding` below.
 *
 * Two reasons, both "the reflow's only answer here would be to undo the gesture": the DAY (the
 * buffer, the weekend, or a thing already fixed) and the SLOT (a start in manual-only time — a
 * visual margin, whose minutes the engine's index space does not hold). The slot is read at the
 * START, not across the footprint: minutes past the periods are hours the reflow carries onward.
 *
 * A GAP answers `fixed` and is therefore always literal; nothing else about it is different, which
 * is the whole reason it can be dragged at all.
 */
export function dropLandsLiterally(input: DropPin): boolean {
  if (input.fixed || input.role !== 'auto') return true;
  return startsInManualOnlyTime(
    input.periods,
    firstWorkingMinute(input.manualWindows, input.startMinutes),
    input.durationMinutes,
  );
}

// ---------------------------------------------------------------------------
// Aiming below what a day holds
// ---------------------------------------------------------------------------

/**
 * One day as a landing place: both views of it, its role, and whether the engine lays it out at
 * all. `DayConfig` satisfies it once `reflows` is filled in from `dayReflows`.
 */
export interface DropDay {
  /** Auto-fill's view. Its first minute is where a drop that rolled onto this day lands. */
  periods: readonly WorkPeriod[];
  /** A hand action's view: what the drop is measured over where it was released. */
  manualWindows: readonly WorkPeriod[];
  /**
   * `dayReflows`: false for the weekend, a closed day and the past — the three kinds of day this
   * roll neither leaves nor lands on.
   */
  reflows: boolean;
  /** Which day this is, for `dropLandsLiterally`: only a literal drop has a footprint to fit. */
  role: DayRole;
}

export interface DropLandingInput {
  date: string;
  startMinutes: number;
  /** Net working minutes — the whole unit's, since the whole unit moves as one row. */
  durationMinutes: number;
  dayOf: (date: string) => DropDay;
  /**
   * The thing being dragged is fixed by itself, so it lands literally on any day and its footprint
   * has to fit. Defaults to false — an unlocked row.
   */
  fixed?: boolean;
  /** How far forward to look for a day that can hold it. */
  maxDays?: number;
}

export interface DropLanding {
  date: string;
  startMinutes: number;
}

/** A fortnight is more than enough to clear a closed week, and it always terminates. */
const MAX_LANDING_DAYS = 14;

/**
 * Where a drop aimed below what its day can hold really lands: the next day the engine would use,
 * at the top of its PERIODS — never a top margin, which would padlock a run nobody asked to fix.
 * Only for a drop that LANDS LITERALLY; a queue rank has no footprint to fit. A candidate day is
 * measured over its periods, the day of the RELEASE over its manual windows. A run no day can hold
 * is left where it was released, for the write path's end-of-day refusal to answer.
 */
export function dropLanding(input: DropLandingInput): DropLanding {
  const here = input.dayOf(input.date);
  // A minute with no working time means the next minute that has some: 14:00, 15:00 and 15:29 all
  // mean 15:30. Settled HERE because this start is what the padlock, the queue rank and the
  // ghost's rectangle are all decided from.
  const startMinutes = firstWorkingMinute(here.manualWindows, input.startMinutes);
  const released = { date: input.date, startMinutes };
  if (fitsFrom(here.manualWindows, startMinutes, input.durationMinutes)) return released;
  if (!here.reflows) return released;
  // A queue rank has no footprint to fit: the reflow fills what the day has left and carries the
  // rest forward, so there is nothing here for another DATE to solve.
  const literal = dropLandsLiterally({
    fixed: input.fixed ?? false,
    role: here.role,
    periods: here.periods,
    manualWindows: here.manualWindows,
    startMinutes,
    durationMinutes: input.durationMinutes,
  });
  if (!literal) return released;

  const horizon = input.maxDays ?? MAX_LANDING_DAYS;
  for (let step = 1; step <= horizon; step += 1) {
    const date = addDays(input.date, step);
    const day = input.dayOf(date);
    if (!day.reflows) continue;
    const opening = day.periods[0]?.startMinutes;
    if (opening === undefined) continue;
    if (!fitsFrom(day.periods, opening, input.durationMinutes)) continue;
    return { date, startMinutes: opening };
  }

  return released;
}

/** True when a row of `netMinutes` starting there still ends inside those windows. */
function fitsFrom(
  windows: readonly WorkPeriod[],
  startMinutes: number,
  netMinutes: number,
): boolean {
  return clockEndOf(windows, startMinutes, netMinutes) <= dayEndMinutes(windows);
}
