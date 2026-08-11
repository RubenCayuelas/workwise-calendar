/**
 * The `day_overrides` table — whole-day exceptions: a holiday, a closed week, a
 * one-off day with different hours.
 *
 * Per CLAUDE.md's implementer defaults there is NO Settings UI for this in v0.2,
 * on purpose: the table and the engine support ship now so a holiday is a row away
 * instead of a migration away. The scheduler reads every day through
 * `getDayConfig(date)` (global settings -> weekday rule -> override), so this
 * repository has no other caller yet.
 *
 * `capacity_hours = NULL` means "use the global stop line"; `capacity_hours = 0` is
 * a legitimate "open, but no auto-fill today", which the engine honours.
 * `date` is the primary key: one override per day, so writes are an upsert.
 */

import { getDb, type Db } from '../db';
import { mapDayOverrideRow, type DayOverride, type DayOverrideRow } from '../../types';
import { prepared } from './statements';

const COLUMNS = 'date, is_closed, capacity_hours, note';

/** Every override. The table holds a handful of rows, so the engine takes all of them. */
export function listDayOverrides(db: Db = getDb()): DayOverride[] {
  return prepared<DayOverrideRow>(db, `SELECT ${COLUMNS} FROM day_overrides ORDER BY date`)
    .all()
    .map(mapDayOverrideRow);
}

export function listDayOverridesBetween(from: string, to: string, db: Db = getDb()): DayOverride[] {
  return prepared<DayOverrideRow>(
    db,
    `SELECT ${COLUMNS} FROM day_overrides WHERE date BETWEEN ? AND ? ORDER BY date`,
  )
    .all(from, to)
    .map(mapDayOverrideRow);
}

export function findDayOverride(date: string, db: Db = getDb()): DayOverride | undefined {
  const row = prepared<DayOverrideRow>(db, `SELECT ${COLUMNS} FROM day_overrides WHERE date = ?`).get(date);
  return row === undefined ? undefined : mapDayOverrideRow(row);
}

/** Insert or replace the override for one day. */
export function upsertDayOverride(override: DayOverride, db: Db = getDb()): DayOverride {
  prepared(
    db,
    `INSERT INTO day_overrides (date, is_closed, capacity_hours, note)
     VALUES (@date, @is_closed, @capacity_hours, @note)
     ON CONFLICT(date) DO UPDATE SET
       is_closed      = excluded.is_closed,
       capacity_hours = excluded.capacity_hours,
       note           = excluded.note`,
  ).run({
    date: override.date,
    is_closed: override.isClosed ? 1 : 0,
    capacity_hours: override.capacityHours,
    note: override.note ?? null,
  });
  const stored = findDayOverride(override.date, db);
  if (stored === undefined) {
    throw new Error(`Day override "${override.date}" disappeared while being written`);
  }
  return stored;
}

export function deleteDayOverride(date: string, db: Db = getDb()): boolean {
  return prepared(db, 'DELETE FROM day_overrides WHERE date = ?').run(date).changes > 0;
}
