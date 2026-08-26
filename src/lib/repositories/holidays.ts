/**
 * The `holidays` cache and the single `holiday_checks` row. Neither is the calendar: the calendar is
 * `day_overrides`, and these two say what the last check found and when it ran.
 */

import { getDb, type Db } from '../db';
import { prepared } from './statements';

export type HolidayLevel = 'national' | 'regional' | 'local';

export interface CachedHoliday {
  date: string;
  name: string;
  level: HolidayLevel;
}

export interface HolidayCheck {
  municipality: string;
  /** An ISO instant, not a calendar day: compared against a clock, never against a date. */
  checkedAt: string;
  succeeded: boolean;
}

interface HolidayRow {
  date: string;
  name: string;
  level: string;
}

interface CheckRow {
  municipality: string;
  checked_at: string;
  succeeded: number;
}

export function listCachedHolidays(db: Db = getDb()): CachedHoliday[] {
  return prepared<HolidayRow>(db, 'SELECT date, name, level FROM holidays ORDER BY date')
    .all()
    .map(mapRow);
}

export function findCachedHoliday(date: string, db: Db = getDb()): CachedHoliday | undefined {
  const row = prepared<HolidayRow>(db, 'SELECT date, name, level FROM holidays WHERE date = ?').get(date);
  return row === undefined ? undefined : mapRow(row);
}

/**
 * The whole cache at once. Replacing rather than merging is what lets a date that stopped being a
 * holiday be noticed: a merge would keep it for ever and the calendar would keep a phantom closed day.
 */
export function replaceCachedHolidays(holidays: readonly CachedHoliday[], db: Db = getDb()): void {
  const insert = prepared(db, 'INSERT INTO holidays (date, name, level) VALUES (?, ?, ?)');
  const write = db.transaction((rows: readonly CachedHoliday[]) => {
    prepared(db, 'DELETE FROM holidays').run();
    for (const holiday of rows) insert.run(holiday.date, holiday.name, holiday.level);
  });
  write(holidays);
}

export function readHolidayCheck(db: Db = getDb()): HolidayCheck | undefined {
  const row = prepared<CheckRow>(
    db,
    'SELECT municipality, checked_at, succeeded FROM holiday_checks WHERE id = 1',
  ).get();
  return row === undefined
    ? undefined
    : { municipality: row.municipality, checkedAt: row.checked_at, succeeded: row.succeeded !== 0 };
}

export function recordHolidayCheck(check: HolidayCheck, db: Db = getDb()): void {
  prepared(
    db,
    `INSERT INTO holiday_checks (id, municipality, checked_at, succeeded) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       municipality = excluded.municipality,
       checked_at   = excluded.checked_at,
       succeeded    = excluded.succeeded`,
  ).run(check.municipality, check.checkedAt, check.succeeded ? 1 : 0);
}

function mapRow(row: HolidayRow): CachedHoliday {
  return { date: row.date, name: row.name, level: row.level as HolidayLevel };
}
