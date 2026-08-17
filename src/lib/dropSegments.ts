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
import { firstWorkingMinute } from './manualWindow';
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
 * A ROW WHOSE START IS NOT WORKING TIME BEGINS AT THE NEXT MINUTE THAT IS
 * (`firstWorkingMinute`), and is then cut like any other. **The returned start may
 * therefore differ from the one that was asked for, and a caller must read it back.** It
 * used to be left alone — "there is no boundary inside such a row to cut it at" — and that
 * was wrong twice over: the boundary is AHEAD of such a row, not inside it, so 2 h released
 * at 14:00 came back as one row `14:00 +120m -> 16:00`, straight through the break the data
 * model says no stored row may cross, claiming two hours of work where ninety minutes of it
 * is lunch. It was not an off-by-one at the edge either: every minute from 14:00 to 15:29
 * did it, because none of them belongs to a window.
 *
 * Two things it still deliberately leaves alone, both of them latitude a hand action really
 * has and neither of them a straddle:
 *
 * - the minutes that run past the LAST window. They stay on the final row, and the
 *   end-of-day guard is what has an opinion about them;
 * - anything whose tail would land past midnight, INCLUDING after the start moved forward.
 *   A row is a rectangle inside ONE day, so the drop is returned precisely as it was made —
 *   at the start it was made at — rather than half-cut, and the caller refuses it as such
 *   (`assertFitsInDay`, and the drawn-footprint cap in the ghost).
 *
 * Always returns at least one segment, so a caller can read `[0]` without a guard.
 */
export function segmentDroppedRow(
  windows: readonly WorkPeriod[],
  row: DropSegment,
): DropSegment[] {
  const rows: DropSegment[] = [];
  let startMinutes = firstWorkingMinute(windows, row.startMinutes);
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

  if (startMinutes + remaining > MINUTES_PER_DAY) return [{ ...row }];
  if (rows.length === 0) return [{ startMinutes, durationMinutes: remaining }];
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
