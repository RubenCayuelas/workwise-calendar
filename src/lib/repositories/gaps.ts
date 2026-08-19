/**
 * The `gaps` table — breaks and holes the owner records (maintenance, a
 * breakdown, admin time).
 *
 * A gap is never moved by anything: "Gaps are time: they consume the day's
 * plannable hours exactly like locked work does." So this module has no placement
 * concept at all, only CRUD. What it does share with blocks is the unit boundary:
 * `start_time` `HH:mm` and `duration` decimal hours on disk, integer minutes above.
 *
 * The lunch break is NOT a row here. It is the implicit hole between period 1 and
 * period 2 in Settings, so switching the afternoon off must never orphan a gap.
 */

import { getDb, type Db } from '../db';
import { minutesToHHmm, minutesToHours } from '../dates';
import { assertRowInsideDay } from '../validation';
import { mapGapRow, type Gap, type GapRow } from '../../types';
import { prepared } from './statements';

const COLUMNS = 'id, date, start_time, duration, reason, unit_id, created_at, updated_at';
const CALENDAR_ORDER = 'ORDER BY date, start_time, id';

export interface NewGap {
  id: string;
  date: string;
  startMinutes: number;
  durationMinutes: number;
  reason?: string;
  /** The unit this row belongs to. Omitted, the row is its own unit. */
  unitId?: string;
}

/** `undefined` leaves a column alone; `null` on `reason` clears it. */
export interface GapPatch {
  date?: string;
  startMinutes?: number;
  durationMinutes?: number;
  reason?: string | null;
}

export function listGaps(db: Db = getDb()): Gap[] {
  return prepared<GapRow>(db, `SELECT ${COLUMNS} FROM gaps ${CALENDAR_ORDER}`).all().map(mapGapRow);
}

export function listGapsBetween(from: string, to: string, db: Db = getDb()): Gap[] {
  return prepared<GapRow>(db, `SELECT ${COLUMNS} FROM gaps WHERE date BETWEEN ? AND ? ${CALENDAR_ORDER}`)
    .all(from, to)
    .map(mapGapRow);
}

export function findGap(id: string, db: Db = getDb()): Gap | undefined {
  const row = prepared<GapRow>(db, `SELECT ${COLUMNS} FROM gaps WHERE id = ?`).get(id);
  return row === undefined ? undefined : mapGapRow(row);
}

/**
 * `assertRowInsideDay` sits here, and in `updateGap`, for the reason it sits in the block writer: so
 * no caller can go around it. `assertGapFits` in the operations layer segments and refuses far more
 * than this, but it only guards the two paths that call it — this guards the table.
 */
export function insertGap(gap: NewGap, db: Db = getDb()): Gap {
  assertRowInsideDay({ id: gap.id, date: gap.date, startMinutes: gap.startMinutes, durationMinutes: gap.durationMinutes });
  prepared(
    db,
    `INSERT INTO gaps (id, date, start_time, duration, reason, unit_id)
     VALUES (@id, @date, @start_time, @duration, @reason, @unit_id)`,
  ).run({
    id: gap.id,
    date: gap.date,
    start_time: minutesToHHmm(gap.startMinutes),
    duration: minutesToHours(gap.durationMinutes),
    reason: gap.reason ?? null,
    unit_id: gap.unitId ?? gap.id,
  });
  return requireStored(gap.id, db);
}

export function updateGap(id: string, patch: GapPatch, db: Db = getDb()): Gap | undefined {
  const assignments: string[] = [];
  const params: Record<string, unknown> = { id };

  if (patch.date !== undefined) {
    assignments.push('date = @date');
    params.date = patch.date;
  }
  if (patch.startMinutes !== undefined) {
    assignments.push('start_time = @start_time');
    params.start_time = minutesToHHmm(patch.startMinutes);
  }
  if (patch.durationMinutes !== undefined) {
    assignments.push('duration = @duration');
    params.duration = minutesToHours(patch.durationMinutes);
  }
  if (patch.reason !== undefined) {
    assignments.push('reason = @reason');
    params.reason = patch.reason;
  }

  if (assignments.length === 0) return findGap(id, db);

  // Asked of the MERGED row: a patch that moves the start without restating the duration still has to
  // land inside the day.
  const stored = findGap(id, db);
  if (stored !== undefined) {
    assertRowInsideDay({
      id,
      date: patch.date ?? stored.date,
      startMinutes: patch.startMinutes ?? stored.startMinutes,
      durationMinutes: patch.durationMinutes ?? stored.durationMinutes,
    });
  }

  const result = prepared(db, `UPDATE gaps SET ${assignments.join(', ')} WHERE id = @id`).run(params);
  return result.changes === 0 ? undefined : requireStored(id, db);
}

/** Every row of one unit, in calendar order. The halves around the comida come back together. */
export function listGapsOfUnit(unitId: string, db: Db = getDb()): Gap[] {
  return prepared<GapRow>(db, `SELECT ${COLUMNS} FROM gaps WHERE unit_id = ? ${CALENDAR_ORDER}`)
    .all(unitId)
    .map(mapGapRow);
}

export function deleteGap(id: string, db: Db = getDb()): boolean {
  return prepared(db, 'DELETE FROM gaps WHERE id = ?').run(id).changes > 0;
}

function requireStored(id: string, db: Db): Gap {
  const gap = findGap(id, db);
  if (gap === undefined) {
    throw new Error(`Gap "${id}" disappeared while being written`);
  }
  return gap;
}
