/**
 * How a hand drop is stored: cut at the break between two working periods. One implementation, imported by `resolveManualPlacement` and by the drag
 * ghost, because a preview that promises what the server will not do is worse than no preview.
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
 * The rows a hand-dropped stretch is stored as: cut wherever it holds minutes on both sides of a
 * NON-WORKING INTERVAL BETWEEN TWO WINDOWS. `duration` is net working time, so 6 h at 10:00 is
 * 10:00-14:00 plus 15:30-17:30. `windows` is the caller's view of the day and every hand action
 * passes the MANUAL WINDOWS, which is what lets a row starting in a margin run on into the period
 * below it. A start that is not working time moves to the next minute that is, so **the returned
 * start may differ from the one asked for and a caller must read it back**. Minutes past the LAST
 * window stay on the final row, and a stretch whose tail would pass midnight comes back UNCUT so
 * the caller can refuse the drop as it was made. Always returns at least one segment.
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
