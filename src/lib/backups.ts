import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { instantToLocalStamp } from './dates';
import type { Db } from './db';

/**
 * Copying `calendar.db` is NOT a backup. WAL keeps recent pages outside the main file — on the
 * shop's own calendar the sidecar was 688 KB against 73 KB of database — so a file copy silently
 * loses most of the recent work. `VACUUM INTO` asks SQLite for one consistent, compacted file with
 * no sidecars, which is also what makes a copy safe to take while the app is running.
 */
export function writeBackup(db: Db, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // VACUUM INTO refuses to overwrite, and the pre-restore copy is deliberately a single file.
  fs.rmSync(destination, { force: true });
  db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
}

/** Beside the database, so an app update replacing the program folder cannot take them with it. */
export function backupsDirOf(dbPath: string): string {
  return path.join(path.dirname(path.resolve(dbPath)), 'backups');
}

/**
 * The copy taken immediately before a restore: ONE file, overwritten each time, never rotated.
 * Deliberately not localised — the app has to find it again whatever language it is running in.
 */
export const BEFORE_RESTORE_NAME = 'workwise-before-restore.db';

const AUTOMATIC_PATTERN = /^workwise-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})\.db$/;

export function automaticBackupName(at: Date): string {
  return `workwise-${instantToLocalStamp(at)}.db`;
}

/**
 * Whether the rotation owns this file. It only ever deletes names it could have written itself, so a
 * copy saved by hand into the same folder survives a limit of three.
 */
export function isAutomaticBackup(name: string): boolean {
  return AUTOMATIC_PATTERN.test(name);
}

export interface StoredBackup {
  name: string;
  /** Local date of the copy, `YYYY-MM-DD`, read from the NAME and not from the filesystem. */
  date: string;
  /** Local time of the copy, `HH:mm`. */
  time: string;
  bytes: number;
}

/**
 * The automatic copies, newest first. Ordered by NAME: it sorts chronologically by construction, and
 * a modification time is whatever the last thing to touch the file left behind.
 */
export function listAutomaticBackups(dir: string): StoredBackup[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  return names
    .filter(isAutomaticBackup)
    .sort()
    .reverse()
    .map((name) => {
      const [, date, hour, minute] = AUTOMATIC_PATTERN.exec(name) as RegExpExecArray;
      return { name, date, time: `${hour}:${minute}`, bytes: fs.statSync(path.join(dir, name)).size };
    });
}

/**
 * Whether the newest copy is old enough to take another. `newest` is the name of a copy, so the
 * decision is derived from the FOLDER: holding "when the last backup ran" in the database would let
 * restoring an old copy also restore its timestamp, and the app would believe it had just run one.
 */
export function backupIsDue(newest: string | undefined, now: Date, everyDays: number): boolean {
  if (newest === undefined) return true;
  const match = AUTOMATIC_PATTERN.exec(newest);
  if (!match) return true;
  const stamp = instantToLocalStamp(now);
  const [, date, hour, minute] = match;
  return elapsedDays(`${date}-${hour}${minute}`, stamp) >= everyDays;
}

/** Whole days between two `YYYY-MM-DD-HHmm` stamps, floored. Local throughout, so DST cannot skew it. */
function elapsedDays(from: string, to: string): number {
  return Math.floor((minutesOfStamp(to) - minutesOfStamp(from)) / (24 * 60));
}

function minutesOfStamp(stamp: string): number {
  const [year, month, day, clock] = stamp.split('-');
  const days = Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86_400_000;
  return days * 24 * 60 + Number(clock.slice(0, 2)) * 60 + Number(clock.slice(2));
}

/** Deletes the oldest automatic copies until `keep` remain. Returns the names it removed. */
export function rotateBackups(dir: string, keep: number): string[] {
  const stale = listAutomaticBackups(dir).slice(Math.max(keep, 0));
  for (const backup of stale) fs.rmSync(path.join(dir, backup.name), { force: true });
  return stale.map((backup) => backup.name);
}

/** Every table a Workwise database has to have for a restore to be worth attempting. */
const REQUIRED_TABLES = ['projects', 'blocks', 'gaps', 'settings', 'day_overrides'];

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

export type BackupRejection = 'not-sqlite' | 'not-workwise';

/**
 * Whether a file is a Workwise database, checked BEFORE anything is replaced: the header bytes, then
 * the tables. Without this, restoring the wrong file leaves the app with no database to open and no
 * way back through its own interface.
 */
export function inspectBackupFile(filePath: string): BackupRejection | null {
  let handle: number;
  try {
    handle = fs.openSync(filePath, 'r');
  } catch {
    return 'not-sqlite';
  }

  try {
    const header = Buffer.alloc(SQLITE_MAGIC.length);
    const read = fs.readSync(handle, header, 0, header.length, 0);
    if (read < header.length || !header.equals(SQLITE_MAGIC)) return 'not-sqlite';
  } finally {
    fs.closeSync(handle);
  }

  let candidate: Database.Database | undefined;
  try {
    candidate = new Database(filePath, { readonly: true });
    const rows = candidate
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const present = new Set(rows.map((row) => row.name));
    return REQUIRED_TABLES.every((table) => present.has(table)) ? null : 'not-workwise';
  } catch {
    return 'not-sqlite';
  } finally {
    candidate?.close();
  }
}
