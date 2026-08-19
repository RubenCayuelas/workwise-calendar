/**
 * Where a drop is really aimed: `aimAtThirds` quantises the aim against the row under it, and
 * `resolveDropDay` moves a release the day cannot hold onto the next day the engine would use.
 * Both pure.
 */

import { dropLanding, dropLandsLiterally } from '../../lib/dropSlide';
import { clockEndOf, dayEndMinutes, firstWorkingMinute } from '../../lib/manualWindow';
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
 * The minute the drop really means, once the row under it has had its say. Over free time the aim
 * is left exactly as it came — the owner is pointing at the clock. Over a row it collapses to that
 * row's START, MIDDLE or END: before it, cut it, after it.
 *
 * A row too short to cut has TWO targets: under two snap steps neither half of a cut could be a
 * legal row, so it splits down the middle. The cut is the row's snapped MIDPOINT and never within
 * a snap step of either end — the owner is choosing a row to cut, not a minute to cut it at.
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
 * The day and minute a release really resolves to, and how it got there. Named for the ANSWER:
 * `DropDay` in src/lib/dropSlide.ts is one of this function's INPUTS, and two exported types with
 * one name and opposite meanings is how the next agent silently wires the wrong one.
 */
export interface AimedDrop {
  date: string;
  startMinutes: number;
  /**
   * The release did not fit the day it was made on and moved to the next day the engine would
   * use. The ghost is drawn on THAT column, so the drop is never a surprise.
   */
  rolled: boolean;
  /**
   * Nowhere later could hold it either, so the start was pulled UP to the last minute that fits.
   * The one case the ghost stops following the pointer — said out loud.
   */
  clamped: boolean;
}

/**
 * Aiming below what the day can hold means the next day. `dropLanding` (src/lib/dropSlide.ts) is
 * the rule, imported rather than mirrored: this file and the write path were briefly two
 * implementations of it. Added here is only what the server has no opinion about — the clamp, a
 * fact about the drag axis, and the two flags the ghost speaks with.
 *
 * The walk stops at the WEEK ON SCREEN, so a run no remaining day of it can hold is clamped rather
 * than rolled onto a column the owner is not looking at. The server never sees the difference: a
 * clamped release fits by construction, and `dropLanding` returns a fitting release untouched.
 */
export function resolveDropDay(input: {
  /** The week's days in calendar order — the roll walks them forward. */
  days: readonly WeekDay[];
  date: string;
  startMinutes: number;
  /** The whole run's net working minutes: what the request will carry. */
  durationMinutes: number;
  /**
   * The dragged unit is fixed by itself — padlocked, or an absence — so it lands literally and its
   * footprint has to fit the day. Without it a Mon-Thu release is a queue RANK with no footprint to
   * fit, so neither the roll nor the clamp has anything to solve.
   */
  fixed?: boolean;
  /**
   * May this gesture be carried to another DATE at all? False for an ABSENCE: the owner names the
   * day a machine broke as deliberately as the hour, so moving it to the next one would be a bigger
   * surprise than the clamp — the same reason a weekend drop is never rolled either.
   */
  rolls?: boolean;
  timeline: Timeline;
}): AimedDrop {
  const day = input.days.find((candidate) => candidate.date === input.date);
  if (day === undefined) {
    return { date: input.date, startMinutes: input.startMinutes, rolled: false, clamped: false };
  }

  const landing =
    input.rolls === false
      ? // Nowhere else to go, so only the start is settled — and by the same rule `dropLanding`
        // applies first: a release with no working time under it means the next minute that has
        // some, so anywhere in the comida is 15:30.
        { date: input.date, startMinutes: firstWorkingMinute(day.manualWindows, input.startMinutes) }
      : dropLanding({
          date: input.date,
          startMinutes: input.startMinutes,
          durationMinutes: input.durationMinutes,
          fixed: input.fixed ?? false,
          dayOf: (date) => {
            const candidate = input.days.find((other) => other.date === date);
            if (candidate === undefined) {
              return { periods: [], manualWindows: [], reflows: false, role: 'manual' };
            }
            return {
              periods: candidate.periods,
              manualWindows: candidate.manualWindows,
              reflows: dayReflowsOn(candidate),
              role: candidate.role,
            };
          },
          maxDays: input.days.length,
        });
  if (landing.date !== input.date) {
    return { ...landing, rolled: true, clamped: false };
  }

  /*
   * A queue rank is never clamped either: it stores no geometry, so clamping pulled the ghost up
   * to a minute the owner had not aimed at, said «no pueden empezar después de…» about a release
   * that works, and then sent a different rank. Same question the server asks.
   */
  if (
    !dropLandsLiterally({
      fixed: input.fixed ?? false,
      role: day.role,
      periods: day.periods,
      manualWindows: day.manualWindows,
      startMinutes: landing.startMinutes,
      durationMinutes: input.durationMinutes,
    })
  ) {
    return { date: input.date, startMinutes: landing.startMinutes, rolled: false, clamped: false };
  }

  // It landed on the day it was released on: either it fitted, or nothing later could hold it, and
  // only the second needs the clamp. THE LANDING'S MINUTE IS TAKEN, NOT `input.startMinutes` —
  // `dropLanding` reads a release with no working time under it as the next minute that has some,
  // so anywhere in the lunch band is 15:30. Not reported as `clamped`: nothing hit a limit.
  if (fitsFrom(day.manualWindows, landing.startMinutes, input.durationMinutes)) {
    return { date: input.date, startMinutes: landing.startMinutes, rolled: false, clamped: false };
  }

  const clamped = clampDropStart(
    day.manualWindows,
    landing.startMinutes,
    input.durationMinutes,
    input.timeline,
  );
  return {
    date: input.date,
    startMinutes: clamped,
    rolled: false,
    clamped: clamped < landing.startMinutes,
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
