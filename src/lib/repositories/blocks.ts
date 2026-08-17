/**
 * The `blocks` table.
 *
 * Two boundaries live here:
 *
 * - `start_time` is `HH:mm` TEXT and `duration` is decimal hours on disk;
 *   `Block.startMinutes` / `Block.durationMinutes` are integers above.
 *   `mapBlockRow` converts, and `toBlockRow`'s halves are inlined into the write
 *   statements because an INSERT lets SQLite fill the timestamps.
 * - `locked` and `manual_duration` are 0/1 on disk and real booleans above.
 *
 * The default order is `ORDER BY date, start_time`, which is not cosmetic: per
 * CLAUDE.md the QUEUE ORDER IS THE VISUAL ORDER, so this ordering is the engine's
 * input ordering. `created_at, id` follow it as tie-breakers, matching the
 * engine's own `sortedByQueueRank`, so two rows that share a slot are always read
 * in the same sequence.
 */

import { getDb, type Db } from '../db';
import { hoursToMinutes, minutesToHHmm, minutesToHours } from '../dates';
import { assertRowInsideDay } from '../validation';
import { mapBlockRow, type Block, type BlockRow } from '../../types';
import { prepared } from './statements';

const COLUMNS =
  'id, project_id, date, start_time, duration, locked, manual_duration, created_at, updated_at';
const QUEUE_ORDER = 'ORDER BY date, start_time, created_at, id';

/**
 * A block's placement: everything the composition engine decides, and nothing it
 * does not (the timestamps belong to SQLite). This is the shape of
 * `PlacedBlock` with the id resolved, which is what the scheduler writes.
 */
export interface BlockPlacement {
  id: string;
  projectId: string;
  date: string;
  startMinutes: number;
  durationMinutes: number;
  /** The engine never moves it — the padlock, whoever's gesture set it. See CLAUDE.md. */
  locked: boolean;
  /** The duration was set by hand, so the engine keeps it. See CLAUDE.md. */
  manualDuration: boolean;
}

/** The whole calendar in queue order. Small table; the engine wants all of it. */
export function listBlocks(db: Db = getDb()): Block[] {
  return prepared<BlockRow>(db, `SELECT ${COLUMNS} FROM blocks ${QUEUE_ORDER}`).all().map(mapBlockRow);
}

/** Inclusive on both ends — `date` is a sortable `YYYY-MM-DD`, so BETWEEN works. */
export function listBlocksBetween(from: string, to: string, db: Db = getDb()): Block[] {
  return prepared<BlockRow>(db, `SELECT ${COLUMNS} FROM blocks WHERE date BETWEEN ? AND ? ${QUEUE_ORDER}`)
    .all(from, to)
    .map(mapBlockRow);
}

/** One job's blocks, in queue order — what the job panel lists as "4 tramos". */
export function listBlocksByProject(projectId: string, db: Db = getDb()): Block[] {
  return prepared<BlockRow>(db, `SELECT ${COLUMNS} FROM blocks WHERE project_id = ? ${QUEUE_ORDER}`)
    .all(projectId)
    .map(mapBlockRow);
}

export function findBlock(id: string, db: Db = getDb()): Block | undefined {
  const row = prepared<BlockRow>(db, `SELECT ${COLUMNS} FROM blocks WHERE id = ?`).get(id);
  return row === undefined ? undefined : mapBlockRow(row);
}

/**
 * Inserts a row the engine placed. The id comes from the caller because
 * `compose` may already have handed it out (see src/lib/ids.ts).
 */
export function insertBlock(placement: BlockPlacement, db: Db = getDb()): void {
  prepared(
    db,
    `INSERT INTO blocks (id, project_id, date, start_time, duration, locked, manual_duration)
     VALUES (@id, @project_id, @date, @start_time, @duration, @locked, @manual_duration)`,
  ).run(toParams(placement));
}

/** Rewrites a row's placement. Returns false when the row is gone. */
export function updateBlock(placement: BlockPlacement, db: Db = getDb()): boolean {
  const result = prepared(
    db,
    `UPDATE blocks
        SET project_id      = @project_id,
            date            = @date,
            start_time      = @start_time,
            duration        = @duration,
            locked          = @locked,
            manual_duration = @manual_duration
      WHERE id = @id`,
  ).run(toParams(placement));
  return result.changes > 0;
}

/** The lock toggle, on its own: it is the one edit that changes no geometry. */
export function setBlockLocked(id: string, locked: boolean, db: Db = getDb()): boolean {
  return prepared(db, 'UPDATE blocks SET locked = ? WHERE id = ?').run(locked ? 1 : 0, id).changes > 0;
}

export function deleteBlock(id: string, db: Db = getDb()): boolean {
  return prepared(db, 'DELETE FROM blocks WHERE id = ?').run(id).changes > 0;
}

/** Bulk delete for a recomposition's `deletedBlockIds`. */
export function deleteBlocks(ids: readonly string[], db: Db = getDb()): number {
  if (ids.length === 0) return 0;
  const statement = prepared(db, 'DELETE FROM blocks WHERE id = ?');
  let deleted = 0;
  for (const id of ids) deleted += statement.run(id).changes;
  return deleted;
}

/**
 * The other half of the invariant the scheduler asserts: each project's blocks
 * summed in integer minutes. Deliberately NOT `SUM(duration)` in SQL — adding
 * decimal hours in floating point is exactly the drift the minutes convention
 * exists to avoid, and this comparison has to be exact.
 */
export function blockMinutesByProject(db: Db = getDb()): Map<string, number> {
  const rows = prepared<{ project_id: string; duration: number }>(
    db,
    'SELECT project_id, duration FROM blocks',
  ).all();
  const sums = new Map<string, number>();
  for (const row of rows) {
    sums.set(row.project_id, (sums.get(row.project_id) ?? 0) + hoursToMinutes(row.duration));
  }
  return sums;
}

/**
 * The engine's decision as SQL parameters — and the one gate every stored row passes
 * through, since `insertBlock` and `updateBlock` are the only two writes that touch a
 * block's geometry (`setBlockLocked` changes a flag and nothing else).
 *
 * `assertRowInsideDay` sits here rather than in the operations for exactly that reason:
 * a row running past midnight is unrenderable — it threw out of `useFormat().time` and
 * took the whole week view down — so the guard has to be somewhere no caller can go
 * around, present or future, whatever produced the row. It throws, which inside
 * `recompose`'s transaction is what rolls the write back.
 */
function toParams(placement: BlockPlacement): Record<string, unknown> {
  assertRowInsideDay(placement);
  return {
    id: placement.id,
    project_id: placement.projectId,
    date: placement.date,
    start_time: minutesToHHmm(placement.startMinutes),
    duration: minutesToHours(placement.durationMinutes),
    locked: placement.locked ? 1 : 0,
    manual_duration: placement.manualDuration ? 1 : 0,
  };
}
