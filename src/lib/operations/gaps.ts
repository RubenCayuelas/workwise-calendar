/**
 * A gap's `duration` is NET WORKING MINUTES, like a block's, and no stored gap row straddles the
 * break. Every occupancy reader in the app depends on it: it is what makes
 * `startMinutes + durationMinutes` a gap row's CLOCK extent. THE SEGMENTATION THEREFORE HAPPENS ON
 * THE WAY IN, here, and nowhere else.
 *
 * The grid's two gestures — dragging an absence and sizing it by its bottom edge — are this same
 * `patchGap`, with `action` naming which one is asking. Nothing about the write differs; what
 * `action` buys is the frozen past, which the form must still reach and they must not.
 */

import { getDb, type Db } from '../db';
import { compareDates, minutesToHHmm, todayLocal } from '../dates';
import { findGapConflicts, type GapConflict, type ScheduleSummary } from '../composition';
import { segmentDroppedRow, type DropSegment } from '../dropSegments';
import { conflict, notFound, ERROR_MESSAGE_KEYS } from '../errors';
import { newId } from '../ids';
import { dayEndMinutes } from '../manualWindow';
import { getDayConfig, recompose, runTransaction } from '../scheduler';
import { assertFitsInDay, assertRowWithinDayEnd } from '../validation';
import { listBlocks } from '../repositories/blocks';
import {
  deleteGap as deleteGapRow,
  findGap,
  insertGap,
  listGaps,
  listGapsBetween,
  listGapsOfUnit,
  updateGap,
} from '../repositories/gaps';
import { listProjects } from '../repositories/projects';
import type { Gap } from '../../types';

export interface GapMutation {
  /** The row the request is about: the first of them, and the one a PATCH updated in place. */
  gap: Gap;
  /** Every row the save wrote, in clock order. Two of them for a gap cut at the comida. */
  gaps: Gap[];
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
 *
 * The hours are stored as one row per manual window they reach, sharing the reason: 8 h from 10:00 is
 * `10:00 +4 h` and `15:30 +4 h`. A start inside the comida becomes the first minute that can hold
 * work, so THE STORED START MAY DIFFER FROM THE ONE ASKED FOR and callers read it back.
 */
export function createGap(input: SaveGapInput, db: Db = getDb()): GapMutation {
  const today = input.today ?? todayLocal();

  return runTransaction(db, () => {
    const rows = assertGapFits(
      { date: input.date, startMinutes: input.startMinutes, durationMinutes: input.durationMinutes },
      today,
      db,
    );

    // One unit id across every segment: the halves around the comida are ONE absence, and the grid
    // must not have to guess that from two identical reason strings.
    const unitId = newId();
    const gaps = rows.map((row) =>
      insertGap(
        {
          id: newId(),
          date: input.date,
          startMinutes: row.startMinutes,
          durationMinutes: row.durationMinutes,
          reason: input.reason,
          unitId,
        },
        db,
      ),
    );

    const report = recompose(db, { today });
    return { gap: gaps[0], gaps, summary: report.summary };
  });
}

/**
 * Which gesture is asking. A gap is edited in its FORM on any day, the past included — a past
 * absence is part of the record and the record is corrected in a form — but the two GRID gestures
 * are frozen there exactly as a block's are. The form sends the same three fields a drag does, so
 * they cannot be told apart by their payload and the caller has to say.
 */
export type GapGesture = 'edit' | 'move' | 'resize';

export interface PatchGapInput {
  date?: string;
  startMinutes?: number;
  durationMinutes?: number;
  /** `null` clears the reason. */
  reason?: string | null;
  /** Absent means `edit`, which is what an HTTP caller with no gesture in mind means. */
  action?: GapGesture;
  today?: string;
}

/**
 * A PATCH ADDRESSES THE WHOLE UNIT, whichever of its rows is named: the two halves around the comida
 * are one absence with one reason, so editing either of them edits the absence. The geometry defaults
 * to the unit's own — its first row's date and start, and the SUM of its net durations — and the rows
 * it becomes are reconciled against the rows it has: the earliest ids are kept and re-pointed, a
 * segment with no row left to take it is inserted, and a row no segment reaches is DELETED.
 *
 * Reconciling is the whole point. Inserting the segments and leaving the old rows alone wrote a
 * duplicate far half on every edit that crossed the comida, unboundedly and with a 200.
 */
export function patchGap(gapId: string, input: PatchGapInput, db: Db = getDb()): GapMutation {
  const today = input.today ?? todayLocal();

  return runTransaction(db, () => {
    const current = findGap(gapId, db);
    if (current === undefined) {
      throw notFound('gap-not-found', ERROR_MESSAGE_KEYS.gapNotFound, { details: { gapId } });
    }

    // Every row of the absence, in calendar order, so the edit is measured over the unit rather than
    // over whichever half the caller happened to name.
    const unitRows = listGapsOfUnit(current.unitId, db);
    const rowsOfUnit = unitRows.length === 0 ? [current] : unitRows;
    const head = rowsOfUnit[0];
    const unitMinutes = rowsOfUnit.reduce((total, row) => total + row.durationMinutes, 0);

    const candidate = {
      date: input.date ?? head.date,
      startMinutes: input.startMinutes ?? head.startMinutes,
      durationMinutes: input.durationMinutes ?? unitMinutes,
    };
    if (input.action === 'move' || input.action === 'resize') {
      assertGestureNotPast(head.date, today, { gapId, date: head.date });
      assertNotPastTarget(candidate.date, today);
    }
    // The stored end gives a gap a settings change left hanging past the day's end the same latitude
    // a block has there: still editable, as long as the edit does not make the overrun worse. Read
    // off the unit's LAST row, which is where the absence really ends — measured from the row the
    // caller happened to name, a two-row unit was given its morning half's end as its tolerance.
    const segments = assertGapFits(
      candidate,
      today,
      db,
      rowsOfUnit[rowsOfUnit.length - 1],
      current.unitId,
    );

    // One reason for the unit: `undefined` keeps what is stored, `null` clears it.
    const reason = (input.reason === undefined ? head.reason : input.reason) ?? undefined;

    const gaps: Gap[] = segments.map((row, index) => {
      const existing = rowsOfUnit[index];
      if (existing === undefined) {
        return insertGap(
          {
            id: newId(),
            date: candidate.date,
            startMinutes: row.startMinutes,
            durationMinutes: row.durationMinutes,
            reason,
            unitId: current.unitId,
          },
          db,
        );
      }
      const written = updateGap(
        existing.id,
        {
          date: candidate.date,
          reason: reason ?? null,
          // The segmented row, never the coordinates asked for: a start inside the comida moves.
          startMinutes: row.startMinutes,
          durationMinutes: row.durationMinutes,
        },
        db,
      );
      if (written === undefined) {
        throw notFound('gap-not-found', ERROR_MESSAGE_KEYS.gapNotFound, { details: { gapId: existing.id } });
      }
      return written;
    });

    // A row no segment reached is gone, not orphaned: shrinking back below the comida used to leave
    // the afternoon half on disk, so a 1 h absence read as 3 h.
    for (const stale of rowsOfUnit.slice(segments.length)) {
      deleteGapRow(stale.id, db);
    }

    const report = recompose(db, { today });
    return { gap: gaps[0], gaps, summary: report.summary };
  });
}

/**
 * Deletes the whole UNIT, whichever of its rows is named: an absence that crosses the comida is one
 * thing on screen, so it must not take two deletions to remove.
 */
export function deleteGap(
  gapId: string,
  options: { today?: string } = {},
  db: Db = getDb(),
): { summary: ScheduleSummary } {
  const today = options.today ?? todayLocal();

  return runTransaction(db, () => {
    const current = findGap(gapId, db);
    if (current === undefined) {
      throw notFound('gap-not-found', ERROR_MESSAGE_KEYS.gapNotFound, { details: { gapId } });
    }
    const rows = listGapsOfUnit(current.unitId, db);
    for (const row of rows.length === 0 ? [current] : rows) {
      deleteGapRow(row.id, db);
    }
    const report = recompose(db, { today });
    return { summary: report.summary };
  });
}

/**
 * The past is the RECORD of what the shop did, so no GRID gesture writes there — neither end: an
 * absence stored on a past day is not dragged or resized, and none is dragged ONTO one. The way to
 * correct a past absence is its form, which is what `action` distinguishes.
 */
function assertGestureNotPast(date: string, today: string, details: Record<string, unknown>): void {
  if (compareDates(date, today) >= 0) return;
  throw conflict('past-gap-frozen', ERROR_MESSAGE_KEYS.pastGapFrozen, {
    details: { ...details, date, today },
  });
}

/** The same sentence a block's drop gets, and it names no job: it is about the DAY. */
function assertNotPastTarget(date: string, today: string): void {
  if (compareDates(date, today) >= 0) return;
  throw conflict('drop-onto-past-day', ERROR_MESSAGE_KEYS.dropOntoPastDay, {
    field: 'date',
    details: { date, today },
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
 * The rows the gap will be stored as, once every refusal has passed. The order matters: the request is
 * cut into rows FIRST, and the day's end and the fixed work are then asked of those rows. Measured
 * against `start + duration` instead, an 8 h gap from 10:00 tests 10:00-18:00 — minutes of the comida
 * that hold nothing, and not the 18:00-19:30 its real second half lands on.
 *
 * The ACTIONABLE conflict is reported first when several are present: a padlock can be undone, the
 * frozen past and the weekend cannot.
 */
function assertGapFits(
  gap: { date: string; startMinutes: number; durationMinutes: number },
  today: string,
  db: Db,
  stored?: Pick<Gap, 'startMinutes' | 'durationMinutes'>,
  excludeUnitId?: string,
): DropSegment[] {
  // Checked on the MERGED gap rather than on the payload, so a PATCH that moves the
  // start without restating the duration is still tested as the rectangle it becomes.
  assertFitsInDay(gap.startMinutes, gap.durationMinutes);

  const { manualWindows } = getDayConfig(gap.date, db);
  const rows = segmentDroppedRow(manualWindows, gap);
  const last = rows[rows.length - 1];
  assertRowWithinDayEnd(
    { date: gap.date, startMinutes: last.startMinutes, durationMinutes: last.durationMinutes },
    dayEndMinutes(manualWindows),
    stored === undefined ? undefined : stored.startMinutes + stored.durationMinutes,
  );

  // GAPS AND BLOCKS ARE ONE OCCUPANCY SET, so an absence may not be written over another absence
  // either. Nothing enforced it while a gap could only be typed; a drag makes the collision a
  // one-gesture accident, and two overlapping absences are indistinguishable from a write-path bug.
  // The unit being written is not its own obstacle: it is what is moving.
  const others = listGaps(db).filter((row) => row.date === gap.date && row.unitId !== excludeUnitId);
  for (const row of rows) {
    const end = row.startMinutes + row.durationMinutes;
    const hit = others.find(
      (other) => other.startMinutes < end && other.startMinutes + other.durationMinutes > row.startMinutes,
    );
    if (hit === undefined) continue;
    throw conflict('gap-over-gap', ERROR_MESSAGE_KEYS.gapOverGap, {
      details: {
        gapId: hit.id,
        date: hit.date,
        startTime: minutesToHHmm(hit.startMinutes),
        endTime: minutesToHHmm(hit.startMinutes + hit.durationMinutes),
        reasonSuffix: hit.reason === undefined || hit.reason === '' ? '' : ` («${hit.reason}»)`,
      },
    });
  }

  const blocks = listBlocks(db);
  const conflicts = rows.flatMap((row) =>
    findGapConflicts(blocks, { date: gap.date, ...row }, today),
  );
  if (conflicts.length === 0) return rows;

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
