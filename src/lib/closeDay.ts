/**
 * "Stop the day here": the arithmetic behind the one-click gap from a chosen moment to the
 * end of the last working period.
 *
 * It deliberately does not predict where the displaced hours land — only `compose` knows
 * that — so the plan reports the hours the day loses and the work that cannot stay.
 */

import { netMinutesBetween } from './manualWindow';
import type { WorkPeriod } from '../types';

/** One row on the day, with its job's name for the preview. */
export interface CloseDayBlock {
  id: string;
  projectId: string;
  /** The job's name. */
  name: string;
  startMinutes: number;
  durationMinutes: number;
  locked: boolean;
}

/**
 * One stored row of occupancy: an existing gap. Its duration is net working minutes, and since no
 * stored row straddles the break that is also the clock interval the arithmetic below reads.
 */
export interface CloseDaySpan {
  startMinutes: number;
  durationMinutes: number;
}

/** One day as this planner reads it. Built by the grid, which has all of it already. */
export interface CloseDayInput {
  date: string;
  /** The day's working periods, in any order. A closed day has none. */
  periods: readonly WorkPeriod[];
  /** Every block on that day. */
  blocks: readonly CloseDayBlock[];
  /** Every gap already on that day, so a second close does not double count. */
  gaps: readonly CloseDaySpan[];
}

/** A job whose hours cannot stay inside the closed stretch. */
export interface CloseDayDisplacement {
  projectId: string;
  name: string;
  /** Its minutes inside the closed stretch. */
  minutes: number;
}

/** A locked row inside the stretch: the gap cannot be saved while it is there. */
export interface CloseDayConflict {
  blockId: string;
  projectId: string;
  name: string;
  startMinutes: number;
  durationMinutes: number;
}

export interface CloseDayPlan {
  date: string;
  /** The gap's start: the moment the day stops. */
  startMinutes: number;
  /**
   * End of the day's last working PERIOD, which is where the closed stretch ends. Stopping the day
   * stops the shift, not the bottom margin — that time was never planned anyway.
   */
  endMinutes: number;
  /**
   * NET working minutes of the gap, which is what a gap's duration means. `endMinutes − startMinutes`
   * would charge the day for the comida: closing at 13:00 on the documented shift is 5 h, not 6.5.
   */
  durationMinutes: number;
  /**
   * The rows the gap will really be stored as: closing at 13:00 proposes `13:00 +1 h` and
   * `15:30 +4 h`. The save still sends the stretch as ONE request, which `createGap` cuts the same way.
   */
  rows: CloseDaySpan[];
  /**
   * The plannable minutes the day actually loses: working time inside the stretch that no
   * existing gap already holds, as a union of intervals so an overlapping gap is not
   * counted twice. Zero means there is nothing left to close.
   */
  workingMinutes: number;
  /** Jobs with hours inside the stretch, in clock order. Unlocked rows only. */
  displaced: CloseDayDisplacement[];
  /** Locked rows inside the stretch. Non-empty means the save will be refused. */
  locked: CloseDayConflict[];
}

/** What the calendar hands the gap form when the owner says "stop the day here". */
export interface CloseDayRequest {
  input: CloseDayInput;
  /** The moment the action proposed: the end of the block it was invoked from. */
  fromMinutes: number;
}

/**
 * End of the day's last WORKING PERIOD, or `undefined` on a day with no periods.
 *
 * Not `dayEndMinutes` from `manualWindow.ts`, which this file also imports: that one is the end of the
 * last MANUAL WINDOW — margins included — and falls back to midnight instead of `undefined`. Same
 * shape, different answer, and the distinction between a period and a manual window is one the rules
 * require naming everywhere, so the two may not share a name.
 */
export function lastPeriodEndMinutes(periods: readonly WorkPeriod[]): number | undefined {
  const sorted = sortedPeriods(periods);
  return sorted.length === 0 ? undefined : sorted[sorted.length - 1].endMinutes;
}

/**
 * The gap that closing the day at `fromMinutes` would create, or `null` when there is no
 * day left to close. `fromMinutes` is clamped up to the day's start: closing "from before
 * the shift" closes the whole day rather than hanging a gap in the top margin.
 */
export function planCloseDay(input: CloseDayInput, fromMinutes: number): CloseDayPlan | null {
  const periods = sortedPeriods(input.periods);
  if (periods.length === 0) return null;

  const endMinutes = periods[periods.length - 1].endMinutes;
  const startMinutes = Math.max(Math.round(fromMinutes), periods[0].startMinutes);
  if (startMinutes >= endMinutes) return null;

  const displaced = new Map<string, CloseDayDisplacement>();
  const locked: CloseDayConflict[] = [];

  for (const block of [...input.blocks].sort((a, b) => a.startMinutes - b.startMinutes)) {
    const minutes = overlapMinutes(block, startMinutes, endMinutes);
    if (minutes <= 0) continue;

    if (block.locked) {
      locked.push({
        blockId: block.id,
        projectId: block.projectId,
        name: block.name,
        startMinutes: block.startMinutes,
        durationMinutes: block.durationMinutes,
      });
      continue;
    }

    const entry = displaced.get(block.projectId);
    if (entry === undefined) {
      displaced.set(block.projectId, { projectId: block.projectId, name: block.name, minutes });
    } else {
      entry.minutes += minutes;
    }
  }

  return {
    date: input.date,
    startMinutes,
    endMinutes,
    durationMinutes: netMinutesBetween(periods, startMinutes, endMinutes),
    rows: closedRows(periods, startMinutes, endMinutes),
    workingMinutes: freeWorkingMinutes(periods, input.gaps, startMinutes, endMinutes),
    displaced: [...displaced.values()],
    locked,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function sortedPeriods(periods: readonly WorkPeriod[]): WorkPeriod[] {
  return [...periods]
    .filter((period) => period.endMinutes > period.startMinutes)
    .sort((a, b) => a.startMinutes - b.startMinutes);
}

/**
 * The stretch `[from, to)` as stored gap rows: its minutes inside each PERIOD, in clock order. The
 * periods and not the manual windows, because closing the day closes the shift — a margin was never
 * planned, so there is nothing there to close.
 */
function closedRows(periods: readonly WorkPeriod[], from: number, to: number): CloseDaySpan[] {
  const rows: CloseDaySpan[] = [];
  for (const period of periods) {
    const start = Math.max(period.startMinutes, from);
    const end = Math.min(period.endMinutes, to);
    if (end > start) rows.push({ startMinutes: start, durationMinutes: end - start });
  }
  return rows;
}

function overlapMinutes(span: CloseDaySpan, from: number, to: number): number {
  return Math.max(
    0,
    Math.min(span.startMinutes + span.durationMinutes, to) - Math.max(span.startMinutes, from),
  );
}

/** Working minutes inside `[from, to)` that no gap already holds. */
function freeWorkingMinutes(
  periods: readonly WorkPeriod[],
  gaps: readonly CloseDaySpan[],
  from: number,
  to: number,
): number {
  let total = 0;
  for (const period of periods) {
    const start = Math.max(period.startMinutes, from);
    const end = Math.min(period.endMinutes, to);
    if (end <= start) continue;
    total += end - start - coveredMinutes(gaps, start, end);
  }
  return Math.max(0, total);
}

/** How much of `[from, to)` the gaps cover, counting overlapping gaps once. */
function coveredMinutes(gaps: readonly CloseDaySpan[], from: number, to: number): number {
  const spans = gaps
    .map((gap) => ({
      start: Math.max(gap.startMinutes, from),
      end: Math.min(gap.startMinutes + gap.durationMinutes, to),
    }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);

  let total = 0;
  let cursor = from;
  for (const span of spans) {
    const start = Math.max(span.start, cursor);
    if (span.end > start) {
      total += span.end - start;
      cursor = span.end;
    }
  }
  return total;
}
