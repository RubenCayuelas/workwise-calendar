import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BEFORE_RESTORE_NAME, listAutomaticBackups, writeBackup } from '../backups';
import { closeDb, getDb } from '../db';
import { AppError } from '../errors';
import { writeSettings } from '../settings';
import { exportBackup, listBackups, restoreBackup, takeAutomaticBackup } from './backups';

let root: string;
let dbPath: string;
let backupsDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'workwise-ops-backups-'));
  dbPath = path.join(root, 'data', 'calendar.db');
  backupsDir = path.join(root, 'data', 'backups');
  process.env.WORKWISE_DB_PATH = dbPath;
});

afterEach(() => {
  closeDb();
  delete process.env.WORKWISE_DB_PATH;
});

function addJob(name: string): void {
  getDb()
    .prepare('INSERT INTO projects (id, name, color, total_hours) VALUES (?, ?, ?, 4)')
    .run(name.toLowerCase(), name, '#249E30');
}

function jobNames(): string[] {
  return (getDb().prepare('SELECT name FROM projects ORDER BY name').all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

/** Runs `work` and returns the AppError it threw, failing the test if it did not. */
function refusal(work: () => unknown): AppError {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the operation to be refused');
}

const MONDAY = new Date('2026-08-10T09:00:00+02:00');
const A_WEEK_LATER = new Date('2026-08-17T09:00:00+02:00');

describe('the automatic copy', () => {
  it('takes one the first time, because there is none to be newer than', () => {
    addJob('Railing');

    const result = takeAutomaticBackup(MONDAY);

    expect(result.created).toBe('workwise-2026-08-10-0900.db');
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(backupsDir, result.created as string))).toBe(true);
  });

  it('does nothing while the newest is younger than the interval', () => {
    takeAutomaticBackup(MONDAY);
    expect(takeAutomaticBackup(new Date('2026-08-14T09:00:00+02:00'))).toMatchObject({
      created: null,
      skipped: 'not-due',
    });
    expect(listAutomaticBackups(backupsDir)).toHaveLength(1);
  });

  it('takes another once the interval has passed', () => {
    takeAutomaticBackup(MONDAY);
    expect(takeAutomaticBackup(A_WEEK_LATER).created).toBe('workwise-2026-08-17-0900.db');
    expect(listAutomaticBackups(backupsDir)).toHaveLength(2);
  });

  it('does nothing at all while the setting is off, and writes no folder', () => {
    writeSettings({ backupsEnabled: false });

    expect(takeAutomaticBackup(MONDAY)).toMatchObject({ created: null, skipped: 'disabled' });
    expect(fs.existsSync(backupsDir)).toBe(false);
  });

  it('rotates down to the limit, oldest first', () => {
    writeSettings({ backupsKept: 2, backupEveryDays: 1 });
    for (const day of ['10', '11', '12']) {
      takeAutomaticBackup(new Date(`2026-08-${day}T09:00:00+02:00`));
    }

    // Rotation runs with every copy, so the third already dropped the first: the fourth drops one.
    expect(listAutomaticBackups(backupsDir)).toHaveLength(2);
    const last = takeAutomaticBackup(new Date('2026-08-13T09:00:00+02:00'));
    expect(last.removed).toEqual(['workwise-2026-08-11-0900.db']);
    expect(listAutomaticBackups(backupsDir).map((backup) => backup.name)).toEqual([
      'workwise-2026-08-13-0900.db',
      'workwise-2026-08-12-0900.db',
    ]);
  });

  it('lowering the limit deletes nothing until the next copy is taken', () => {
    writeSettings({ backupEveryDays: 1 });
    for (const day of ['10', '11', '12']) {
      takeAutomaticBackup(new Date(`2026-08-${day}T09:00:00+02:00`));
    }

    writeSettings({ backupsKept: 1 });

    expect(listAutomaticBackups(backupsDir)).toHaveLength(3);
    // Now it applies: three plus the new one, down to the one the owner asked to keep.
    expect(takeAutomaticBackup(new Date('2026-08-13T09:00:00+02:00')).removed).toHaveLength(3);
    expect(listAutomaticBackups(backupsDir)).toHaveLength(1);
  });
});

describe('the list Settings shows', () => {
  it('names the folder and the copies, and hides files it does not own', () => {
    takeAutomaticBackup(MONDAY);
    fs.writeFileSync(path.join(backupsDir, 'before the holidays.db'), 'x');

    const list = listBackups();

    expect(list.directory).toBe(backupsDir);
    expect(list.backups.map((backup) => backup.name)).toEqual(['workwise-2026-08-10-0900.db']);
  });
});

describe('saving a copy anywhere', () => {
  it('writes a database that can be opened on its own', () => {
    addJob('Railing');

    const { filePath, fileName } = exportBackup(MONDAY);

    expect(fileName).toBe('workwise-2026-08-10-0900.db');
    const copy = new Database(filePath, { readonly: true });
    expect(copy.prepare('SELECT name FROM projects').all()).toEqual([{ name: 'Railing' }]);
    copy.close();
    // It is a temporary file, not one of the kept copies.
    expect(fs.existsSync(backupsDir)).toBe(false);
  });
});

describe('restoring', () => {
  it('brings the calendar back from a copy in the folder', () => {
    addJob('Railing');
    const created = takeAutomaticBackup(MONDAY).created as string;
    addJob('Staircase');
    expect(jobNames()).toEqual(['Railing', 'Staircase']);

    const result = restoreBackup({ name: created });

    expect(jobNames()).toEqual(['Railing']);
    expect(result.previousSavedAs).toBe(BEFORE_RESTORE_NAME);
  });

  it('keeps the replaced calendar, so a wrong restore is not final', () => {
    addJob('Railing');
    const created = takeAutomaticBackup(MONDAY).created as string;
    addJob('Staircase');

    restoreBackup({ name: created });

    const previous = new Database(path.join(backupsDir, BEFORE_RESTORE_NAME), { readonly: true });
    expect(previous.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 2 });
    previous.close();
    // And it is not one of the copies the rotation can reach.
    expect(listAutomaticBackups(backupsDir).map((b) => b.name)).not.toContain(BEFORE_RESTORE_NAME);
  });

  it('accepts a file from anywhere on the disk, not just the folder', () => {
    addJob('Railing');
    const elsewhere = path.join(root, 'usb', 'my copy.db');
    writeBackup(getDb(), elsewhere);
    addJob('Staircase');

    restoreBackup({ uploaded: fs.readFileSync(elsewhere) });

    expect(jobNames()).toEqual(['Railing']);
  });

  it('leaves no WAL sidecar from the calendar it replaced', () => {
    addJob('Railing');
    const created = takeAutomaticBackup(MONDAY).created as string;
    addJob('Staircase');

    restoreBackup({ name: created });
    // Read once, so the handle is open and the file is live again.
    expect(jobNames()).toEqual(['Railing']);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);
  });

  it('starts the undo timeline over, so nothing can be undone into a calendar that is gone', () => {
    addJob('Railing');
    const created = takeAutomaticBackup(MONDAY).created as string;
    getDb()
      .prepare("INSERT INTO history (kind, state, fingerprint) VALUES ('x', '{}', 'f')")
      .run();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM history').get()).toEqual({ n: 1 });

    restoreBackup({ name: created });

    expect(getDb().prepare('SELECT COUNT(*) AS n FROM history').get()).toEqual({ n: 0 });
  });

  it('migrates a copy taken by an older version of the app', () => {
    addJob('Railing');
    const older = path.join(root, 'older.db');
    writeBackup(getDb(), older);
    // What a copy from before the gap unit ids looks like on disk.
    const shrunk = new Database(older);
    shrunk.exec('ALTER TABLE gaps DROP COLUMN unit_id');
    shrunk.exec('DELETE FROM data_migrations');
    shrunk.close();

    restoreBackup({ uploaded: fs.readFileSync(older) });

    const columns = (getDb().prepare('PRAGMA table_info(gaps)').all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(columns).toContain('unit_id');
    expect(jobNames()).toEqual(['Railing']);
  });
});

describe('a restore that is refused changes nothing', () => {
  it('refuses a file that is not a database', () => {
    addJob('Railing');

    const error = refusal(() => restoreBackup({ uploaded: Buffer.from('holiday photo') }));

    expect(error.code).toBe('backup-not-a-database');
    expect(error.status).toBe(400);
    expect(jobNames()).toEqual(['Railing']);
  });

  it('refuses a database belonging to something else', () => {
    addJob('Railing');
    const other = path.join(root, 'other.db');
    const db = new Database(other);
    db.exec('CREATE TABLE contacts (id TEXT)');
    db.close();

    const error = refusal(() => restoreBackup({ uploaded: fs.readFileSync(other) }));

    expect(error.code).toBe('backup-not-workwise');
    expect(jobNames()).toEqual(['Railing']);
  });

  it('refuses a name that is not in the folder', () => {
    addJob('Railing');
    expect(refusal(() => restoreBackup({ name: 'workwise-2020-01-01-0000.db' })).code).toBe(
      'backup-not-found',
    );
    expect(jobNames()).toEqual(['Railing']);
  });

  it('refuses a name that tries to reach outside the folder', () => {
    addJob('Railing');
    for (const name of ['../calendar.db', '../../etc/passwd', 'calendar.db']) {
      expect(refusal(() => restoreBackup({ name })).code).toBe('backup-not-found');
    }
    expect(jobNames()).toEqual(['Railing']);
  });

  it('leaves no staged file behind after a refusal', () => {
    addJob('Railing');
    takeAutomaticBackup(MONDAY);

    refusal(() => restoreBackup({ uploaded: Buffer.from('nope') }));

    expect(fs.readdirSync(backupsDir).filter((name) => name.startsWith('.incoming'))).toEqual([]);
  });
});
