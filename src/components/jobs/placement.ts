/**
 * What a write actually DID to a job's rows, as data: every panel diffs the rows it had against
 * the rows the API answered with, since queue order makes the result surprising.
 * Nothing here re-implements a scheduling decision.
 */

import { FRIDAY, compareDates, startOfWeek, weekdayOf } from '../../lib/dates';
import type { Block } from '../../types';

/** How one row differs from the way it was before the write. */
export type PlacementKind = 'new' | 'grown' | 'shrunk' | 'moved';

export interface PlacementChange {
  block: Block;
  kind: PlacementKind;
  /** The row sits on a Friday — the buffer. */
  isBuffer: boolean;
  /** The row is outside the week of the reference date, i.e. it slipped to a later week. */
  isLaterWeek: boolean;
}

export interface PlacementOutcome {
  /** How many minutes the job gained (positive) or gave up (negative). */
  minutesDelta: number;
  /** Every row that is new, longer, shorter or somewhere else, in calendar order. */
  changes: PlacementChange[];
  /** Rows that no longer exist: LIFO removal, or auto-merge absorbing one. */
  removedBlockIds: string[];
  /** Any non-shrinking change landed on a Friday. */
  usedBuffer: boolean;
  /** Any non-shrinking change landed in a week after the reference week. */
  spilledToLaterWeek: boolean;
  /** The job's furthest row after the write, or `null` when it has none. */
  furthestDate: string | null;
  hasChanges: boolean;
}

/** Total net working minutes of a set of rows. */
export function sumMinutes(blocks: readonly Block[]): number {
  return blocks.reduce((total, block) => total + block.durationMinutes, 0);
}

/**
 * Compares the job's rows before and after a write. `reference` is the day the "later week"
 * test is made against — pass `WeekView.today`, so it means what the owner sees on screen.
 */
export function describePlacement(
  before: readonly Block[],
  after: readonly Block[],
  reference: string,
): PlacementOutcome {
  const previous = new Map(before.map((block) => [block.id, block]));
  const referenceWeek = startOfWeek(reference);
  const changes: PlacementChange[] = [];

  for (const block of after) {
    const kind = kindOf(previous.get(block.id), block);
    if (kind === undefined) continue;
    changes.push({
      block,
      kind,
      isBuffer: weekdayOf(block.date) === FRIDAY,
      isLaterWeek: compareDates(startOfWeek(block.date), referenceWeek) > 0,
    });
  }

  changes.sort(byCalendarPosition);

  const survivors = new Set(after.map((block) => block.id));
  const removedBlockIds = before.filter((block) => !survivors.has(block.id)).map((block) => block.id);

  const gained = (change: PlacementChange): boolean => change.kind !== 'shrunk';

  return {
    minutesDelta: sumMinutes(after) - sumMinutes(before),
    changes,
    removedBlockIds,
    usedBuffer: changes.some((change) => change.isBuffer && gained(change)),
    spilledToLaterWeek: changes.some((change) => change.isLaterWeek && gained(change)),
    furthestDate: furthestDateOf(after),
    hasChanges: changes.length > 0 || removedBlockIds.length > 0,
  };
}

/**
 * The rows worth naming in a notice: hours that ARRIVED are the interesting part, so new and
 * grown rows win and a save that only moved rows falls back to those. Capped so a long job
 * cannot flood the panel.
 */
export function placementHighlights(outcome: PlacementOutcome, limit = 6): PlacementChange[] {
  const gained = outcome.changes.filter((change) => change.kind === 'new' || change.kind === 'grown');
  const chosen = gained.length > 0 ? gained : outcome.changes;
  return chosen.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Gap conflicts
// ---------------------------------------------------------------------------

/** One row a gap could not be saved over, as `ApiError.details.conflicts` carries it. */
export interface GapConflictInfo {
  blockId: string;
  projectId: string;
  projectName: string;
  date: string;
  startMinutes: number;
  durationMinutes: number;
  reason: 'locked' | 'past' | 'weekend';
}

const CONFLICT_REASONS = new Set(['locked', 'past', 'weekend']);

/** Reads `details.conflicts` defensively — it crossed HTTP as `unknown`. */
export function readGapConflicts(details: Record<string, unknown> | undefined): GapConflictInfo[] {
  const raw = details?.conflicts;
  if (!Array.isArray(raw)) return [];

  const conflicts: GapConflictInfo[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.blockId !== 'string' ||
      typeof candidate.date !== 'string' ||
      typeof candidate.startMinutes !== 'number' ||
      typeof candidate.durationMinutes !== 'number' ||
      typeof candidate.reason !== 'string' ||
      !CONFLICT_REASONS.has(candidate.reason)
    ) {
      continue;
    }
    conflicts.push({
      blockId: candidate.blockId,
      projectId: typeof candidate.projectId === 'string' ? candidate.projectId : '',
      projectName: typeof candidate.projectName === 'string' ? candidate.projectName : '',
      date: candidate.date,
      startMinutes: candidate.startMinutes,
      durationMinutes: candidate.durationMinutes,
      reason: candidate.reason as GapConflictInfo['reason'],
    });
  }
  return conflicts;
}

/**
 * The conflicts the refusal message does NOT already name, so the owner can clear
 * everything in the way in one pass. The headline offender is identified by the `date` and
 * `startTime` the message interpolates, NOT by its position in the array.
 */
export function otherGapConflicts(details: Record<string, unknown> | undefined): GapConflictInfo[] {
  const all = readGapConflicts(details);
  const date = typeof details?.date === 'string' ? details.date : undefined;
  const startMinutes =
    typeof details?.startTime === 'string' ? clockTimeToMinutes(details.startTime) : undefined;

  if (date === undefined || startMinutes === undefined) return all;
  return all.filter(
    (conflict) => !(conflict.date === date && conflict.startMinutes === startMinutes),
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** `"08:00"` to 480. */
function clockTimeToMinutes(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const minutes = Number(match[2]);
  return minutes > 59 ? undefined : Number(match[1]) * 60 + minutes;
}

function kindOf(before: Block | undefined, after: Block): PlacementKind | undefined {
  if (before === undefined) return 'new';
  if (before.date !== after.date || before.startMinutes !== after.startMinutes) return 'moved';
  if (after.durationMinutes > before.durationMinutes) return 'grown';
  if (after.durationMinutes < before.durationMinutes) return 'shrunk';
  return undefined;
}

function byCalendarPosition(a: PlacementChange, b: PlacementChange): number {
  const byDate = compareDates(a.block.date, b.block.date);
  return byDate !== 0 ? byDate : a.block.startMinutes - b.block.startMinutes;
}

function furthestDateOf(blocks: readonly Block[]): string | null {
  let furthest: string | null = null;
  for (const block of blocks) {
    if (furthest === null || compareDates(block.date, furthest) > 0) furthest = block.date;
  }
  return furthest;
}
