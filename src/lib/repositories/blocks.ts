/**
 * The `blocks` table. On disk `start_time` is `HH:mm` TEXT, `duration` is decimal hours and
 * `locked` is 0/1; above, the times are integer minutes and `locked` is a boolean.
 * `mapBlockRow` converts.
 *
 * The default `ORDER BY date, start_time, created_at, id` is the engine's INPUT ordering
 * and matches its own `sortedByQueueRank`.
 *
 * There is no date-range read here, unlike `listGapsBetween` and `listDayOverridesBetween`:
 * the engine reflows the whole horizon from `listBlocks`, so nothing ever wanted one week's
 * blocks alone and the third member of that trio was only ever dead weight.
 */

import { getDb, type Db } from '../db';
import { hoursToMinutes, minutesToHHmm, minutesToHours } from '../dates';
import { assertRowInsideDay } from '../validation';
import { mapBlockRow, type Block, type BlockRow } from '../../types';
import { prepared } from './statements';

const COLUMNS = 'id, project_id, date, start_time, duration, locked, created_at, updated_at';
const QUEUE_ORDER = 'ORDER BY date, start_time, created_at, id';

/** A block's placement: what the engine decides, minus the timestamps SQLite owns. */
export interface BlockPlacement {
  id: string;
  projectId: string;
  date: string;
  startMinutes: number;
  durationMinutes: number;
  /** The padlock: the engine never moves the row. */
  locked: boolean;
}

/** The whole calendar in queue order. Small table; the engine wants all of it. */
export function listBlocks(db: Db = getDb()): Block[] {
  return prepared<BlockRow>(db, `SELECT ${COLUMNS} FROM blocks ${QUEUE_ORDER}`).all().map(mapBlockRow);
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

/** Inserts a row the engine placed; the id comes from the caller (see src/lib/ids.ts). */
export function insertBlock(placement: BlockPlacement, db: Db = getDb()): void {
  prepared(
    db,
    `INSERT INTO blocks (id, project_id, date, start_time, duration, locked)
     VALUES (@id, @project_id, @date, @start_time, @duration, @locked)`,
  ).run(toParams(placement));
}

/** Rewrites a row's placement. Returns false when the row is gone. */
export function updateBlock(placement: BlockPlacement, db: Db = getDb()): boolean {
  const result = prepared(
    db,
    `UPDATE blocks
        SET project_id = @project_id,
            date       = @date,
            start_time = @start_time,
            duration   = @duration,
            locked     = @locked
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
 * Each project's blocks summed in integer minutes. Deliberately NOT `SUM(duration)` in
 * SQL: adding decimal hours in floating point drifts, and this comparison must be exact.
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
 * The engine's decision as SQL parameters, and the one gate every stored row passes
 * through: `insertBlock` and `updateBlock` are the only writes that touch geometry.
 *
 * `assertRowInsideDay` sits here so no caller can go around it — a row running past
 * midnight is unrenderable, it threw out of `useFormat().time` and took the whole week view
 * down. It throws, which inside `recompose`'s transaction rolls the write back.
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
  };
}
