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
  isNameableVersion,
  isPreUpdateBackup,
  isRestorableName,
  listAutomaticBackups,
  listPreUpdateBackups,
  preUpdateBackupName,
  rotateBackups,
  rotatePreUpdateBackups,
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
    // Built from `path`, not written out: `path.resolve` gives a POSIX literal a drive letter on
    // Windows, and the release build runs this suite there.
    const data = path.join(os.tmpdir(), 'workwise', 'data');

    expect(backupsDirOf(path.join(data, 'calendar.db'))).toBe(path.join(data, 'backups'));
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

  it('stamps the version beside the date, so a copy says which update it precedes', () => {
    expect(preUpdateBackupName(at('2026-08-27T14:30:00'), '0.26.0')).toBe(
      'workwise-before-update-2026-08-27-1430-0.26.0.db',
    );
  });

  it('keeps the three kinds of name apart, so no rotation can reach another kind', () => {
    const beforeUpdate = 'workwise-before-update-2026-08-27-1430-0.26.0.db';

    expect(isPreUpdateBackup(beforeUpdate)).toBe(true);
    expect(isAutomaticBackup(beforeUpdate)).toBe(false);
    expect(isPreUpdateBackup('workwise-2026-08-21-1305.db')).toBe(false);
    expect(isPreUpdateBackup(BEFORE_RESTORE_NAME)).toBe(false);
    expect(isPreUpdateBackup('workwise-before-update-0.26.0.db')).toBe(false);
  });
});

describe('the version a copy is named for', () => {
  it('takes what a release can actually be called', () => {
    for (const version of ['0.26.0', '1.0.0-rc.1', '0.26.0+build.7']) {
      expect(isNameableVersion(version)).toBe(true);
    }
  });

  it('refuses anything that could name a file somewhere else', () => {
    // It arrives over HTTP from the shell, so it reaches a filename as untrusted text.
    for (const version of ['../../etc/passwd', '0.26.0/x', '0.26.0\\x', '', 'a b']) {
      expect(isNameableVersion(version)).toBe(false);
    }
  });

  it('cannot be smuggled through the name builder either', () => {
    expect(() => preUpdateBackupName(at('2026-08-27T14:30:00'), '../escape')).toThrow();
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

  it('never touches a copy saved by hand, the pre-restore one, nor a pre-update one', () => {
    const dir = scratch();
    const beforeUpdate = 'workwise-before-update-2026-08-27-1430-0.26.0.db';
    fs.writeFileSync(path.join(dir, 'workwise-2026-08-01-0900.db'), 'x');
    fs.writeFileSync(path.join(dir, 'before the holidays.db'), 'x');
    fs.writeFileSync(path.join(dir, BEFORE_RESTORE_NAME), 'x');
    fs.writeFileSync(path.join(dir, beforeUpdate), 'x');

    rotateBackups(dir, 0);

    expect(fs.existsSync(path.join(dir, 'workwise-2026-08-01-0900.db'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'before the holidays.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, BEFORE_RESTORE_NAME))).toBe(true);
    expect(fs.existsSync(path.join(dir, beforeUpdate))).toBe(true);
  });

  it('deletes nothing when there is room', () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'workwise-2026-08-01-0900.db'), 'x');
    expect(rotateBackups(dir, 3)).toEqual([]);
  });
});

describe('the copies taken before an update', () => {
  const NAMES = [
    'workwise-before-update-2026-06-02-0800-0.24.0.db',
    'workwise-before-update-2026-08-27-1430-0.26.0.db',
    'workwise-before-update-2026-07-15-1100-0.25.0.db',
  ];

  it('reads newest first and carries the version each one precedes', () => {
    const dir = scratch();
    for (const name of [...NAMES, 'workwise-2026-08-21-1305.db', BEFORE_RESTORE_NAME, 'notes.txt']) {
      fs.writeFileSync(path.join(dir, name), 'x');
    }

    expect(listPreUpdateBackups(dir).map((backup) => backup.name)).toEqual([
      'workwise-before-update-2026-08-27-1430-0.26.0.db',
      'workwise-before-update-2026-07-15-1100-0.25.0.db',
      'workwise-before-update-2026-06-02-0800-0.24.0.db',
    ]);
    expect(listPreUpdateBackups(dir)[0]).toMatchObject({
      date: '2026-08-27',
      time: '14:30',
      version: '0.26.0',
      bytes: 1,
    });
  });

  it('orders by the stamp and not by the version, which does not sort', () => {
    const dir = scratch();
    // 0.9.0 is NEWER than 0.10.0, and sorting the version text alone would reverse them.
    fs.writeFileSync(path.join(dir, 'workwise-before-update-2026-08-01-0900-0.10.0.db'), 'x');
    fs.writeFileSync(path.join(dir, 'workwise-before-update-2026-08-20-0900-0.9.0.db'), 'x');

    expect(listPreUpdateBackups(dir).map((backup) => backup.version)).toEqual(['0.9.0', '0.10.0']);
  });

  it('reads an absent folder as no copies rather than throwing', () => {
    expect(listPreUpdateBackups(path.join(scratch(), 'nope'))).toEqual([]);
  });

  it('rotates on its own count, so a busy week of releases cannot empty the weekly copies', () => {
    const dir = scratch();
    for (const name of [...NAMES, 'workwise-2026-08-21-1305.db']) {
      fs.writeFileSync(path.join(dir, name), 'x');
    }

    expect(rotatePreUpdateBackups(dir, 2)).toEqual([
      'workwise-before-update-2026-06-02-0800-0.24.0.db',
    ]);
    expect(listPreUpdateBackups(dir)).toHaveLength(2);
    expect(listAutomaticBackups(dir)).toHaveLength(1);
  });

  it('never touches a copy saved by hand, nor the pre-restore one', () => {
    const dir = scratch();
    for (const name of [...NAMES, 'before the holidays.db', BEFORE_RESTORE_NAME]) {
      fs.writeFileSync(path.join(dir, name), 'x');
    }

    rotatePreUpdateBackups(dir, 0);

    expect(fs.existsSync(path.join(dir, 'before the holidays.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, BEFORE_RESTORE_NAME))).toBe(true);
    expect(listPreUpdateBackups(dir)).toEqual([]);
  });

  it('counts the copy just written as the newest, whatever the clock said', () => {
    // A shop PC with a dead battery boots in the past. Ordered by name alone the new copy is the
    // oldest of the four, and the rotation would delete the very one it had just been given.
    const dir = scratch();
    const justWritten = 'workwise-before-update-2025-01-01-0900-0.27.0.db';
    for (const name of [...NAMES, justWritten]) fs.writeFileSync(path.join(dir, name), 'x');

    const removed = rotatePreUpdateBackups(dir, 3, justWritten);

    expect(removed).toEqual(['workwise-before-update-2026-06-02-0800-0.24.0.db']);
    expect(fs.existsSync(path.join(dir, justWritten))).toBe(true);
  });
});

describe('which names a restore may be asked for', () => {
  it('takes both kinds the app writes, and nothing else', () => {
    expect(isRestorableName('workwise-2026-08-21-1305.db')).toBe(true);
    expect(isRestorableName('workwise-before-update-2026-08-27-1430-0.26.0.db')).toBe(true);

    // The traversal defence is the shape check: `basename` alone leaves `..` intact.
    for (const name of ['../calendar.db', '../../etc/passwd', 'calendar.db', '..']) {
      expect(isRestorableName(name)).toBe(false);
    }
    expect(isRestorableName('before the holidays.db')).toBe(false);
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
