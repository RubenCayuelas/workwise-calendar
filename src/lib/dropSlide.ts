/**
 * Where a PINNED drop really lands on a day the engine reflows: forward, to the first
 * start whose footprint touches nothing immovable.
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

/** `minute`, moved forward to the first minute a window actually covers. */
function insideWindows(windows: readonly WorkPeriod[], minute: number): number {
  for (const window of windows) {
    if (minute < window.startMinutes) return window.startMinutes;
    if (minute < window.endMinutes) return minute;
  }
  return minute;
}
