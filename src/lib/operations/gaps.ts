/**
 * Gap operations.
 *
 * A gap is time: "they consume the day's plannable hours exactly like locked work
 * does", and gaps and blocks are ONE occupancy set. So saving a gap on top of
 * existing work is not a drawing question, it is a scheduling one, and CLAUDE.md's
 * implementer default settles it:
 *
 *   "recompose, pushing unlocked work forward in the same transaction. If the space
 *    is held by a locked block, refuse the save with a message naming the block
 *    rather than creating an overlap."
 *
 * Unlocked weekday work needs no special handling at all — the recomposition that
 * every gap write ends in flows it forward. The only real conflicts are rows the
 * engine may NOT move: locked, in the frozen past, or on a weekend. Those are
 * refused, because `compose` could never repair an overlap it is forbidden to
 * touch. `findGapConflicts` in src/lib/composition.ts is the predicate; this module
 * turns its verdict into a message the UI can word.
 */

import { getDb, type Db } from '../db';
import { minutesToHHmm, todayLocal } from '../dates';
import { findGapConflicts, type GapConflict, type ScheduleSummary } from '../composition';
import { conflict, notFound, ERROR_MESSAGE_KEYS } from '../errors';
import { newId } from '../ids';
import { recompose, runTransaction } from '../scheduler';
import { assertFitsInDay } from '../validation';
import { listBlocks } from '../repositories/blocks';
import {
  deleteGap as deleteGapRow,
  findGap,
  insertGap,
  listGaps,
  listGapsBetween,
  updateGap,
} from '../repositories/gaps';
import { listProjects } from '../repositories/projects';
import type { Gap } from '../../types';

export interface GapMutation {
  gap: Gap;
  summary: ScheduleSummary;
}

export interface SaveGapInput {
  date: string;
  startMinutes: number;
  durationMinutes: number;
  reason?: string;
  today?: string;
}

/** Every gap, or the ones inside an inclusive date window. */
export function readGaps(range: { from?: string; to?: string } = {}, db: Db = getDb()): Gap[] {
  if (range.from !== undefined && range.to !== undefined) {
    return listGapsBetween(range.from, range.to, db);
  }
  return listGaps(db);
}

/**
 * Creates a gap. Refuses if it would land on a row the engine cannot move;
 * otherwise the recomposition pushes the unlocked work out of the way.
 *
 * No intent is passed to `recompose`: losing hours to a breakdown is not growth, so
 * the displaced work goes to the next auto-fill day rather than eating the Friday
 * colchón.
 */
export function createGap(input: SaveGapInput, db: Db = getDb()): GapMutation {
  const today = input.today ?? todayLocal();

  return runTransaction(db, () => {
    assertGapFits(
      { date: input.date, startMinutes: input.startMinutes, durationMinutes: input.durationMinutes },
      today,
      db,
    );

    const gap = insertGap(
      {
        id: newId(),
        date: input.date,
        startMinutes: input.startMinutes,
        durationMinutes: input.durationMinutes,
        reason: input.reason,
      },
      db,
    );

    const report = recompose(db, { today });
    return { gap, summary: report.summary };
  });
}

export interface PatchGapInput {
  date?: string;
  startMinutes?: number;
  durationMinutes?: number;
  /** `null` clears the reason. */
  reason?: string | null;
  today?: string;
}

/** Edits a gap. The merged result is checked against the fixed rows, as on create. */
export function patchGap(gapId: string, input: PatchGapInput, db: Db = getDb()): GapMutation {
  const today = input.today ?? todayLocal();

  return runTransaction(db, () => {
    const current = findGap(gapId, db);
    if (current === undefined) {
      throw notFound('gap-not-found', ERROR_MESSAGE_KEYS.gapNotFound, { details: { gapId } });
    }

    assertGapFits(
      {
        date: input.date ?? current.date,
        startMinutes: input.startMinutes ?? current.startMinutes,
        durationMinutes: input.durationMinutes ?? current.durationMinutes,
      },
      today,
      db,
    );

    const gap = updateGap(gapId, input, db);
    if (gap === undefined) {
      throw notFound('gap-not-found', ERROR_MESSAGE_KEYS.gapNotFound, { details: { gapId } });
    }

    const report = recompose(db, { today });
    return { gap, summary: report.summary };
  });
}

/** Deletes a gap. The freed time is filled by the reflow, Mon-Thu first. */
export function deleteGap(
  gapId: string,
  options: { today?: string } = {},
  db: Db = getDb(),
): { summary: ScheduleSummary } {
  const today = options.today ?? todayLocal();

  return runTransaction(db, () => {
    if (!deleteGapRow(gapId, db)) {
      throw notFound('gap-not-found', ERROR_MESSAGE_KEYS.gapNotFound, { details: { gapId } });
    }
    const report = recompose(db, { today });
    return { summary: report.summary };
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** One conflicting row, with everything a translated sentence may interpolate. */
interface ReportedConflict extends GapConflict {
  projectName: string;
  startTime: string;
  endTime: string;
}

const CONFLICT_KEYS: Record<GapConflict['reason'], string> = {
  locked: ERROR_MESSAGE_KEYS.gapOverLockedBlock,
  past: ERROR_MESSAGE_KEYS.gapOverPastBlock,
  weekend: ERROR_MESSAGE_KEYS.gapOverWeekendBlock,
};

/**
 * Refuses the save when the gap covers a row the engine may not move, naming it.
 *
 * A locked conflict is reported in preference to a past or weekend one when both
 * are present, because it is the actionable one: the owner can unlock the block,
 * whereas the past being frozen is not something to be argued with.
 */
function assertGapFits(
  gap: { date: string; startMinutes: number; durationMinutes: number },
  today: string,
  db: Db,
): void {
  // Checked on the MERGED gap rather than on the payload, so a PATCH that moves the
  // start without restating the duration is still tested as the rectangle it becomes.
  assertFitsInDay(gap.startMinutes, gap.durationMinutes);

  const conflicts = findGapConflicts(listBlocks(db), gap, today);
  if (conflicts.length === 0) return;

  const names = new Map(listProjects(db).map((project) => [project.id, project.name]));
  const reported: ReportedConflict[] = conflicts.map((item) => ({
    ...item,
    projectName: names.get(item.projectId) ?? '',
    startTime: minutesToHHmm(item.startMinutes),
    endTime: minutesToHHmm(item.startMinutes + item.durationMinutes),
  }));
  const headline = reported.find((item) => item.reason === 'locked') ?? reported[0];

  throw conflict('gap-over-fixed-block', CONFLICT_KEYS[headline.reason], {
    details: {
      projectName: headline.projectName,
      date: headline.date,
      startTime: headline.startTime,
      endTime: headline.endTime,
      reason: headline.reason,
      conflicts: reported,
    },
  });
}
