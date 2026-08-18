/**
 * "Stop the day here": the arithmetic behind the one-click gap that says
 * *we only do this much today*.
 *
 * WHY THIS IS AN ACTION AND NOT A RESIZE. Shrinking an unlocked future block does not
 * survive the reflow — the engine re-derives a job's segmentation from the job's total,
 * so an internal transfer between two adjacent rows of one queue item is undone. That is
 * correct: it is what makes the calendar self-tidying. And a hole the engine refuses to
 * fill would be the app lying, because if nothing occupies the rest of the day then the
 * shop IS free then, and saying so is the whole point of the app.
 *
 * So the honest way to cap a day is to say the day is over: a gap from the chosen moment
 * to the end of the last working period. Plannable hours are
 * `min(capacity, period minutes − gaps and locked work)`, so the day genuinely holds
 * less and the work that no longer fits is replanned by the engine.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: predict where those hours land. Only
 * `compose` can answer that, over the whole calendar rather than the seven days a screen
 * holds, and it may well cut a job across several days (*Fill and Overflow, Always*). So
 * the plan reports what is certain — the hours the day loses, and the work that cannot
 * stay inside the closed stretch — and the calendar shows the rest the moment it saves.
 */

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

/** Anything already occupying clock time: an existing gap. */
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
  /** End of the day's last working period, which is where the gap ends. */
  endMinutes: number;
  /** Wall-clock minutes of the gap — it may span the lunch break. */
  durationMinutes: number;
  /**
   * The plannable minutes the day actually loses: working time inside the stretch that
   * no existing gap already holds. A union of intervals, exactly as the engine's
   * `plannableMinutes` computes occupancy, so an overlapping gap is never counted twice.
   * Zero means there is nothing left to close.
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

/** End of the day's last working period, or `undefined` on a day with no periods. */
export function dayEndMinutes(periods: readonly WorkPeriod[]): number | undefined {
  const sorted = sortedPeriods(periods);
  return sorted.length === 0 ? undefined : sorted[sorted.length - 1].endMinutes;
}

/**
 * The gap that closing the day at `fromMinutes` would create, or `null` when there is
 * no day left to close (no periods at all, or a moment at or after the last one ends).
 *
 * `fromMinutes` is clamped up to the day's start: closing "from before the shift" is
 * closing the whole day, not a gap hanging in the top margin.
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
    durationMinutes: endMinutes - startMinutes,
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
