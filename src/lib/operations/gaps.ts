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
 * No intent is passed to `recompose`, so displaced work goes to the next auto-fill day,
 * not the Friday colchón.
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
 * The ACTIONABLE conflict is reported first when several are present: a padlock can be
 * undone, the frozen past and the weekend cannot.
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
