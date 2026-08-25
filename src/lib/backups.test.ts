import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BEFORE_RESTORE_NAME,
  automaticBackupName,
  backupIsDue,
  backupsDirOf,
  inspectBackupFile,
  isAutomaticBackup,
  listAutomaticBackups,
  rotateBackups,
  writeBackup,
} from './backups';
import { closeDb, openDatabase } from './db';

const roots: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workwise-backups-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  closeDb();
});

/** A stamp in the shop's timezone, so the fixtures read like the filenames the app writes. */
function at(local: string): Date {
  return new Date(`${local}+02:00`);
}

describe('where the copies live', () => {
  it('puts them beside the database, not beside the program', () => {
    expect(backupsDirOf('/opt/workwise/data/calendar.db')).toBe('/opt/workwise/data/backups');
    expect(backupsDirOf('C:/Users/x/AppData/Workwise/calendar.db')).toContain('backups');
  });
});

describe('naming', () => {
  it('stamps the local date and time, so the name sorts chronologically', () => {
    expect(automaticBackupName(at('2026-08-21T13:05:00'))).toBe('workwise-2026-08-21-1305.db');
  });

  it('recognises only names it could have written itself', () => {
    expect(isAutomaticBackup('workwise-2026-08-21-1305.db')).toBe(true);
    // Everything a person might save into the same folder, which the rotation must never delete.
    expect(isAutomaticBackup('antes de las vacaciones.db')).toBe(false);
    expect(isAutomaticBackup(BEFORE_RESTORE_NAME)).toBe(false);
    expect(isAutomaticBackup('workwise-2026-08-21.db')).toBe(false);
    expect(isAutomaticBackup('workwise-2026-08-21-1305.db.bak')).toBe(false);
  });
});

describe('taking a copy', () => {
  it('captures rows that are still only in the WAL, which a file copy would lose', () => {
    const root = scratch();
    const dbPath = path.join(root, 'calendar.db');
    const db = openDatabase(dbPath);
    // Straight to SQL: the point is the storage layer, not the engine.
    db.prepare("INSERT INTO projects (id, name, color, total_hours) VALUES ('p', 'Railing', '#1EA42B', 4)").run();

    const walBytes = fs.statSync(`${dbPath}-wal`).size;
    expect(walBytes).toBeGreaterThan(0);

    const copy = path.join(root, 'copy.db');
    writeBackup(db, copy);

    const restored = new Database(copy, { readonly: true });
    expect(restored.prepare('SELECT name FROM projects').all()).toEqual([{ name: 'Railing' }]);
    restored.close();

    // And what a naive backup would have produced instead: on a database this young the WAL still
    // holds the SCHEMA, so the copy has no `projects` table at all — not merely no rows.
    const naive = path.join(root, 'naive.db');
    fs.copyFileSync(dbPath, naive);
    const fromCopy = new Database(naive, { readonly: true });
    expect(() => fromCopy.prepare('SELECT name FROM projects').all()).toThrow(/no such table/);
    fromCopy.close();

    db.close();
  });

  it('leaves no sidecars beside the copy, so one file is the whole backup', () => {
    const root = scratch();
    const db = openDatabase(path.join(root, 'calendar.db'));
    const copy = path.join(root, 'sub', 'copy.db');
    writeBackup(db, copy);

    expect(fs.existsSync(copy)).toBe(true);
    expect(fs.existsSync(`${copy}-wal`)).toBe(false);
    expect(fs.existsSync(`${copy}-shm`)).toBe(false);
    db.close();
  });

  it('overwrites the destination, because the pre-restore copy is one file', () => {
    const root = scratch();
    const db = openDatabase(path.join(root, 'calendar.db'));
    const copy = path.join(root, 'copy.db');
    writeBackup(db, copy);
    expect(() => writeBackup(db, copy)).not.toThrow();
    db.close();
  });
});

describe('listing', () => {
  it('reads newest first and ignores every file it does not own', () => {
    const dir = scratch();
    for (const name of [
      'workwise-2026-08-07-0900.db',
      'workwise-2026-08-21-1305.db',
      'workwise-2026-08-14-1812.db',
      'my own copy.db',
      BEFORE_RESTORE_NAME,
      'notes.txt',
    ]) {
      fs.writeFileSync(path.join(dir, name), 'x');
    }

    expect(listAutomaticBackups(dir).map((backup) => backup.name)).toEqual([
      'workwise-2026-08-21-1305.db',
      'workwise-2026-08-14-1812.db',
      'workwise-2026-08-07-0900.db',
    ]);
    expect(listAutomaticBackups(dir)[0]).toMatchObject({ date: '2026-08-21', time: '13:05', bytes: 1 });
  });

  it('reads an absent folder as no copies rather than throwing', () => {
    expect(listAutomaticBackups(path.join(scratch(), 'nope'))).toEqual([]);
  });
});

describe('rotation', () => {
  it('keeps the newest and deletes the oldest', () => {
    const dir = scratch();
    const names = [
      'workwise-2026-08-01-0900.db',
      'workwise-2026-08-08-0900.db',
      'workwise-2026-08-15-0900.db',
      'workwise-2026-08-22-0900.db',
    ];
    for (const name of names) fs.writeFileSync(path.join(dir, name), 'x');

    expect(rotateBackups(dir, 2)).toEqual(['workwise-2026-08-08-0900.db', 'workwise-2026-08-01-0900.db']);
    expect(listAutomaticBackups(dir).map((b) => b.name)).toEqual([
      'workwise-2026-08-22-0900.db',
      'workwise-2026-08-15-0900.db',
    ]);
  });

  it('never touches a copy saved by hand, nor the pre-restore one', () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'workwise-2026-08-01-0900.db'), 'x');
    fs.writeFileSync(path.join(dir, 'before the holidays.db'), 'x');
    fs.writeFileSync(path.join(dir, BEFORE_RESTORE_NAME), 'x');

    rotateBackups(dir, 0);

    expect(fs.existsSync(path.join(dir, 'workwise-2026-08-01-0900.db'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'before the holidays.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, BEFORE_RESTORE_NAME))).toBe(true);
  });

  it('deletes nothing when there is room', () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'workwise-2026-08-01-0900.db'), 'x');
    expect(rotateBackups(dir, 3)).toEqual([]);
  });
});

describe('when another copy is due', () => {
  it('is due when there is none at all', () => {
    expect(backupIsDue(undefined, at('2026-08-21T13:05:00'), 7)).toBe(true);
  });

  it('is not due before the interval has elapsed', () => {
    const newest = 'workwise-2026-08-14-0900.db';
    expect(backupIsDue(newest, at('2026-08-14T18:00:00'), 7)).toBe(false);
    expect(backupIsDue(newest, at('2026-08-20T23:59:00'), 7)).toBe(false);
  });

  it('is due once it has, and stays due however long the app was closed', () => {
    const newest = 'workwise-2026-08-14-0900.db';
    expect(backupIsDue(newest, at('2026-08-21T09:00:00'), 7)).toBe(true);
    // Three weeks unopened is still ONE copy owed, not three.
    expect(backupIsDue(newest, at('2026-09-04T11:00:00'), 7)).toBe(true);
  });

  it('is due when the newest name is not one of ours, so a stray file cannot stall it', () => {
    expect(backupIsDue('whatever.db', at('2026-08-21T13:05:00'), 7)).toBe(true);
  });
});

describe('checking a file before replacing anything', () => {
  it('accepts a database the app itself wrote', () => {
    const root = scratch();
    const db = openDatabase(path.join(root, 'calendar.db'));
    const copy = path.join(root, 'copy.db');
    writeBackup(db, copy);
    db.close();

    expect(inspectBackupFile(copy)).toBeNull();
  });

  it('refuses something that is not SQLite at all', () => {
    const dir = scratch();
    const wrong = path.join(dir, 'holiday.jpg');
    fs.writeFileSync(wrong, 'not a database');
    expect(inspectBackupFile(wrong)).toBe('not-sqlite');
    expect(inspectBackupFile(path.join(dir, 'absent.db'))).toBe('not-sqlite');
  });

  it('refuses a SQLite file that is some other application', () => {
    const dir = scratch();
    const other = path.join(dir, 'other.db');
    const db = new Database(other);
    db.exec('CREATE TABLE contacts (id TEXT)');
    db.close();

    expect(inspectBackupFile(other)).toBe('not-workwise');
  });
});
