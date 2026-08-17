/**
 * WHERE A DROP REALLY LANDS, when it cannot land exactly where it was released. Two
 * questions, one file, because both are answered by walking FORWARD from the release
 * point and both are needed by the server and by the ghost at once:
 *
 * - `firstClearStart` — the MINUTE: a pinned drop moves down the day to the first start
 *   whose footprint touches nothing immovable.
 * - `dropLanding` — the DAY: a drop aimed below what its day can hold moves to the next
 *   day the calendar would use, at the top of it.
 *
 * WHY IT LIVES ON ITS OWN, next to `segmentDroppedRow` and for the same reason: TWO
 * CALLERS NEED THE IDENTICAL ANSWER AND NEITHER MAY GUESS IT.
 *
 * - `resolveManualPlacement` (src/lib/composition.ts) applies it when it stores the drop.
 * - the drag ghost (src/components/calendar/dropEffect.ts, WeekGrid) draws the drop before
 *   the mouse is released, and a ghost that promises 07:15 for a row the server will store
 *   at 11:00 is worse than no ghost — it is the app appearing to do something else.
 *
 * "IMMOVABLE" IS EXACTLY TWO THINGS: a GAP and a LOCKED row. Everything else on a day the
 * engine reflows either moves by itself or is resolved by the merge and the cut in
 * `resolveManualPlacement`, so these two are the only ones that ever left a drop with
 * nowhere to go — and they are also the two whose minutes the drop may not share: a gap is
 * time, and "a locked block is never grown or shrunk silently".
 *
 * Forward only, because the drop said "here or later", and a no-op for every drop that was
 * already clear — which is nearly all of them. It exists for the day the drop must KEEP:
 * on the Friday colchón a queue rank is worthless (the reflow pulls the row straight back
 * into Mon-Thu), so giving up the exact minute is the only way to honour the gesture.
 *
 * `null` means the day has no such slot, and the caller's answer to that is to give up the
 * PIN rather than to refuse: see `resolveManualPlacement`.
 *
 * Pure arithmetic over integer minutes — no clock, no database, no React — so the browser
 * has it as cheaply as the server does.
 */

import { addDays } from './dates';
import { segmentDroppedRow, overlapsSegments, type DropSegment } from './dropSegments';
import { clockEndOf, dayEndMinutes } from './manualWindow';
import type { WorkPeriod } from '../types';

export interface DropSlideInput {
  /**
   * The day's MANUAL WINDOWS — the periods with the visual margins fused on, which is the
   * view every hand action is cut over. The slid row stays inside one of them: answering a
   * request for a slot by parking the row in the lunch band would be a stranger answer
   * than the collision was.
   */
  windows: readonly WorkPeriod[];
  /**
   * The gaps and the LOCKED rows on the day, in any order. The dragged unit's own rows
   * must not be in here — a row cannot be an obstacle to itself.
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

  // Each step clears one obstacle's END, and an obstacle that ends at or before the start
  // can never be hit again — the footprint begins there — so every step is strictly
  // forward and one pass per obstacle is enough.
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
    startMinutes = insideWindows(input.windows, hit.startMinutes + hit.durationMinutes);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Aiming below what a day holds
// ---------------------------------------------------------------------------

/**
 * ONE DAY, AS A LANDING PLACE: both views of it, and whether the engine lays it out at
 * all. `DayConfig` satisfies it once `reflows` is filled in from `dayReflows`.
 */
export interface DropDay {
  /** Auto-fill's view. Its first minute is where a drop that rolled onto this day lands. */
  periods: readonly WorkPeriod[];
  /** A hand action's view: what the drop is measured over where it was released. */
  manualWindows: readonly WorkPeriod[];
  /**
   * `dayReflows`: the engine decides what sits here. False for the weekend, a closed day
   * and the past — the three kinds of day this roll neither leaves nor lands on.
   */
  reflows: boolean;
}

export interface DropLandingInput {
  date: string;
  startMinutes: number;
  /** Net working minutes — the whole unit's, since the whole unit moves as one row. */
  durationMinutes: number;
  dayOf: (date: string) => DropDay;
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
 * WHERE A DROP AIMED BELOW WHAT ITS DAY CAN HOLD REALLY LANDS: the next day the engine
 * would use, at the top of it.
 *
 * The owner, on being shown the old behaviour — the drop refused and the ghost stuck at
 * the lowest point that fits: *«Que se rechaza, de qué friki. Pasa al siguiente día.
 * ¿Sabes cómo funciona un calendario?»* They are right, and it is the plainest rule in
 * the app: in any calendar, aiming past the end of a day means the day after.
 *
 * It replaces a wall the drag layer had to draw — a 6 h unit could not be aimed below
 * 13:00 on the documented shift, because its footprint would end at 20:45 and the
 * end-of-day guard refused the write — with a landing the ghost can show while dragging,
 * so the day change is never a surprise on release.
 *
 * THREE THINGS BOUND IT, and each one is a place the roll would otherwise be the surprise:
 *
 * - IT ONLY LEAVES A DAY THE ENGINE LAYS OUT, and only lands on one. "The next day the
 *   engine would use" means nothing where the engine chooses nothing: on the weekend, on a
 *   closed day and in the past a drop is a literal placement on a day the owner named on
 *   purpose, so moving it to another date would be a bigger surprise than the refusal. The
 *   Friday colchón IS one of them — overflow from Thursday is what the buffer is for — and
 *   a run that lands there padlocks like any other Friday drop.
 * - IT LANDS AT THE TOP OF THE PERIODS, never in a top margin, and a candidate day is
 *   measured over its PERIODS: a run that only fits by reaching into a margin would come
 *   back PADLOCKED, and the owner asked for the next day, not for a mark. Where the drop
 *   was RELEASED the MANUAL WINDOWS are what it is measured against instead, because a
 *   release into the bottom margin is a legitimate aim and must not roll off the day.
 * - IT GIVES UP RATHER THAN WALKING FOR EVER. A run no day can hold from the top of its
 *   periods is left exactly where it was released, and the write path's own end-of-day
 *   refusal answers for it on the day the owner actually chose.
 *
 * Pure arithmetic over integer minutes, so the drag ghost can reach the same landing the
 * server will store: same reason `firstClearStart` and `segmentDroppedRow` live here.
 */
export function dropLanding(input: DropLandingInput): DropLanding {
  const released = { date: input.date, startMinutes: input.startMinutes };
  const here = input.dayOf(input.date);
  if (fitsFrom(here.manualWindows, input.startMinutes, input.durationMinutes)) return released;
  if (!here.reflows) return released;

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

/** `minute`, moved forward to the first minute a window actually covers. */
function insideWindows(windows: readonly WorkPeriod[], minute: number): number {
  for (const window of windows) {
    if (minute < window.startMinutes) return window.startMinutes;
    if (minute < window.endMinutes) return minute;
  }
  return minute;
}
