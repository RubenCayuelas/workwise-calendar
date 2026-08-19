/**
 * What a settings change would do to work that already exists. Pure interval arithmetic
 * over blocks handed in; the fetching lives in ./scheduleData.ts.
 */

import type { Block, Settings, WorkPeriod } from '../../types';
import { periodsOf, timelineOf } from './shift';

/** A block with its job's name, which is what the warning has to show. */
export interface ScheduledBlock {
  block: Block;
  projectName: string;
}

/**
 * `outside-periods`: the block sits in time the change stops being a working period.
 * `outside-timeline`: a shrunk visual margin would clip it off the drawn axis entirely.
 */
export type AffectedReason = 'outside-periods' | 'outside-timeline';

export interface AffectedBlock extends ScheduledBlock {
  reason: AffectedReason;
}

/** What kind of narrowing a draft represents, before any block is looked at. */
export interface ChangeRisk {
  /** The afternoon is being switched off. */
  disablesAfternoon: boolean;
  /** Working time is being removed — a later start, an earlier end, a period dropped. */
  narrowsPeriods: boolean;
  /** The drawn axis is getting shorter at either end. */
  narrowsTimeline: boolean;
  /** A narrower horizon can make the whole save roll back with `horizon-exceeded`. */
  narrowsHorizon: boolean;
  /** Less auto-fill per day, so queued work moves later. Nothing is stranded by it. */
  lowersCapacity: boolean;
}

export function assessRisk(saved: Settings, draft: Settings): ChangeRisk {
  const savedTimeline = timelineOf(saved);
  const draftTimeline = timelineOf(draft);

  return {
    disablesAfternoon: saved.period2Enabled && !draft.period2Enabled,
    narrowsPeriods: subtractIntervals(periodsOf(saved), periodsOf(draft)).length > 0,
    narrowsTimeline:
      savedTimeline !== undefined &&
      draftTimeline !== undefined &&
      (draftTimeline.startMinutes > savedTimeline.startMinutes ||
        draftTimeline.endMinutes < savedTimeline.endMinutes),
    narrowsHorizon: draft.planningHorizonWeeks < saved.planningHorizonWeeks,
    lowersCapacity: draft.defaultDayCapacity < saved.defaultDayCapacity,
  };
}

/** True when the draft can strand work, so worth the round trip that loads every block. */
export function needsBlockCheck(risk: ChangeRisk): boolean {
  return risk.narrowsPeriods || risk.narrowsTimeline;
}

/**
 * The blocks the change would leave stranded, in calendar order. The past and the weekend
 * are included deliberately: the engine will not move those, so they are the rows that
 * really do stay sitting in dead time after the reflow.
 */
export function findAffectedBlocks(
  saved: Settings,
  draft: Settings,
  scheduled: readonly ScheduledBlock[],
): AffectedBlock[] {
  const draftPeriods = periodsOf(draft);
  // An unusable draft cannot be saved anyway; warning about it would be noise.
  if (draftPeriods.length === 0) return [];

  const removed = subtractIntervals(periodsOf(saved), draftPeriods);
  const timeline = timelineOf(draft);

  const affected: AffectedBlock[] = [];
  for (const entry of scheduled) {
    const start = entry.block.startMinutes;
    const end = start + entry.block.durationMinutes;

    if (removed.some((interval) => overlaps(start, end, interval))) {
      affected.push({ ...entry, reason: 'outside-periods' });
      continue;
    }

    if (timeline !== undefined && (start < timeline.startMinutes || end > timeline.endMinutes)) {
      affected.push({ ...entry, reason: 'outside-timeline' });
    }
  }

  return affected.sort(byCalendarOrder);
}

// ---------------------------------------------------------------------------
// Interval arithmetic
// ---------------------------------------------------------------------------

/**
 * `minuend` minus `subtrahend`: the working time the draft takes away. Both inputs are the
 * short, ordered, non-overlapping lists `periodsOf` returns.
 */
export function subtractIntervals(
  minuend: readonly WorkPeriod[],
  subtrahend: readonly WorkPeriod[],
): WorkPeriod[] {
  let remaining = minuend.map((period) => ({ ...period }));

  for (const cut of subtrahend) {
    const next: WorkPeriod[] = [];
    for (const piece of remaining) {
      if (cut.endMinutes <= piece.startMinutes || cut.startMinutes >= piece.endMinutes) {
        next.push(piece);
        continue;
      }
      if (cut.startMinutes > piece.startMinutes) {
        next.push({ startMinutes: piece.startMinutes, endMinutes: cut.startMinutes });
      }
      if (cut.endMinutes < piece.endMinutes) {
        next.push({ startMinutes: cut.endMinutes, endMinutes: piece.endMinutes });
      }
    }
    remaining = next;
  }

  return remaining;
}

function overlaps(startMinutes: number, endMinutes: number, interval: WorkPeriod): boolean {
  return startMinutes < interval.endMinutes && endMinutes > interval.startMinutes;
}

function byCalendarOrder(a: AffectedBlock, b: AffectedBlock): number {
  if (a.block.date !== b.block.date) return a.block.date < b.block.date ? -1 : 1;
  return a.block.startMinutes - b.block.startMinutes;
}
