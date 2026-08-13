/**
 * How a hand drop is stored: cut at the break between two working periods.
 *
 * CLAUDE.md, *A Drop Is Stored In Segments*: "A dropped block is cut at the break
 * between two working periods, exactly like everything the engine places." 6 h dropped
 * at 10:00 is stored as `10:00-14:00` plus `15:30-17:30`, two rows of one job, on every
 * kind of day.
 *
 * WHY IT LIVES ON ITS OWN, in its own file, instead of inside the engine that applies
 * it: TWO callers need the identical answer and neither may guess it.
 *
 * - `resolveManualPlacement` (src/lib/composition.ts) stores the drop, and measures the
 *   rows it lands across against the time the drop REALLY occupies.
 * - the drag ghost (src/components/calendar/dropEffect.ts, WeekGrid) draws the drop
 *   before the mouse is released, and says what it will do to the row underneath.
 *
 * A preview that promises something the server will not do is worse than no preview at
 * all, and a second implementation of this rule would drift the first time the shift is
 * reconfigured. So there is one implementation and both sides import it. It is pure
 * arithmetic over integer minutes — no clock, no database, no React — so the browser can
 * have it as cheaply as the server can.
 */

import { MINUTES_PER_DAY } from './dates';
import type { WorkPeriod } from '../types';

/** One stored row's worth of a drop. A drop across the lunch break has two. */
export interface DropSegment {
  startMinutes: number;
  durationMinutes: number;
}

/**
 * The rows a hand-dropped stretch is stored as: cut wherever it holds minutes on both
 * sides of a NON-WORKING INTERVAL BETWEEN TWO WINDOWS. `duration` is net working time,
 * so 6 h dropped at 10:00 is 10:00-14:00 plus 15:30-17:30 — the same two rows auto-fill
 * would have produced, and the same rule `toClockSegments` applies to everything the
 * engine places.
 *
 * WHICH VIEW OF THE DAY `windows` IS, THE CALLER DECIDES, and every hand action passes the
 * same one: the MANUAL WINDOWS (`manualWindowsOf`, src/lib/manualWindow.ts), the periods
 * with the visual margins fused on. On the documented shift both views leave the lunch
 * break as the only hole, so the cut is identical — the difference is that a row starting
 * in a margin runs on into the period below it with no boundary between them, which is
 * what makes the margins usable at all.
 *
 * Three things it deliberately leaves alone, all of them latitude a hand action already
 * has and none of them a straddle:
 *
 * - a row that STARTS outside every window — in the lunch band itself, say. There is no
 *   boundary inside such a row to cut it at;
 * - the minutes that run past the LAST window. They stay on the final row;
 * - anything whose tail would land past midnight. A row is a rectangle inside ONE day,
 *   so the drop is left precisely as it was made rather than half-cut.
 *
 * Always returns at least one segment, so a caller can read `[0]` without a guard.
 */
export function segmentDroppedRow(
  windows: readonly WorkPeriod[],
  row: DropSegment,
): DropSegment[] {
  const rows: DropSegment[] = [];
  let startMinutes = row.startMinutes;
  let remaining = row.durationMinutes;

  for (let index = 0; index + 1 < windows.length; index += 1) {
    const breakStart = windows[index].endMinutes;
    const breakEnd = windows[index + 1].startMinutes;
    // A shift configured with no lunch (`period2Start === period1End`) has no break to
    // cut at; a row starting at or after this one is not across it.
    if (breakEnd <= breakStart || startMinutes >= breakStart) continue;
    if (startMinutes + remaining <= breakStart) break;
    rows.push({ startMinutes, durationMinutes: breakStart - startMinutes });
    remaining -= breakStart - startMinutes;
    startMinutes = breakEnd;
  }

  if (rows.length === 0) return [{ ...row }];
  if (startMinutes + remaining > MINUTES_PER_DAY) return [{ ...row }];
  rows.push({ startMinutes, durationMinutes: remaining });
  return rows;
}

/** True when `[start, start + duration)` shares clock minutes with any segment. */
export function overlapsSegments(
  segments: readonly DropSegment[],
  startMinutes: number,
  durationMinutes: number,
): boolean {
  return segments.some(
    (piece) =>
      Math.min(startMinutes + durationMinutes, piece.startMinutes + piece.durationMinutes) >
      Math.max(startMinutes, piece.startMinutes),
  );
}
