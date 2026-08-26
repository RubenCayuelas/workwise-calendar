/**
 * Where the pointer says a band can start, so the grid can say it before the press. Pure, and the
 * start it names comes from `bandStartAt` — the same arithmetic the release stores — because a
 * second opinion here would let the hour the pointer promises differ from the hour that is saved.
 */

import { netMinutesBetween } from '../../lib/manualWindow';
import { CREATE_RAIL_PX, rowAt } from './geometry';
import { bandStartAt } from './paintSession';
import type { WorkPeriod } from '../../types';

/** A stored row, block or gap: what makes a minute occupied. */
export interface AimRow {
  startMinutes: number;
  durationMinutes: number;
}

export interface AimInput {
  /** Pixels from the COLUMN's own left edge, not the block's. */
  x: number;
  /** The minute under the pointer, unsnapped. */
  minutes: number;
  windows: readonly WorkPeriod[];
  /** Every stored row on the day, blocks and gaps alike. */
  rows: readonly AimRow[];
}

/**
 * The minute the reveal names, or `null` where a press would move a row instead of creating one.
 * The create surface is the whole FREE part of a column plus its leftmost `CREATE_RAIL_PX`, so the
 * hairline appears exactly where a press creates and nowhere else — which is how the rule is learnt
 * without anyone explaining it.
 */
export function aimAt(input: AimInput): number | null {
  const onRail = input.x >= 0 && input.x < CREATE_RAIL_PX;
  if (!onRail && rowAt(input.rows, input.minutes) !== undefined) return null;

  const start = bandStartAt(input.windows, input.minutes);
  // Past the last window `firstWorkingMinute` answers the minute it was handed, which is no start at
  // all: a band reaching there would have to be painted upwards and would END on it, not begin. Only
  // reachable on an axis widened to cover a row placed by hand beyond the day.
  if (netMinutesBetween(input.windows, start, start + 1) === 0) return null;
  return start;
}
