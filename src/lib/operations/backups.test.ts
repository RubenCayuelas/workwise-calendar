import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BEFORE_RESTORE_NAME,
  listAutomaticBackups,
  listPreUpdateBackups,
  writeBackup,
} from '../backups';
import { closeDb, getDb } from '../db';
import { AppError } from '../errors';
import { writeSettings } from '../settings';
import {
  exportBackup,
  listBackups,
  restoreBackup,
  takeAutomaticBackup,
  takePreUpdateBackup,
} from './backups';

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
    .run(name.toLowerCase(), name, '#1EA42B');
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

describe('the copy taken before an update installs', () => {
  it('holds the calendar as it stands, under a name saying which update follows', () => {
    addJob('Railing');

    const result = takePreUpdateBackup('0.26.0', MONDAY);

    expect(result.created).toBe('workwise-before-update-2026-08-10-0900-0.26.0.db');
    expect(result.removed).toEqual([]);
    const copy = new Database(path.join(backupsDir, result.created), { readonly: true });
    expect(copy.prepare('SELECT name FROM projects').all()).toEqual([{ name: 'Railing' }]);
    copy.close();
  });

  it('is taken even when the weekly copies are switched off', () => {
    // That setting is about how much sits in the folder. An update cannot be undone, so it is not a
    // decision to install without a way back.
    addJob('Railing');
    writeSettings({ backupsEnabled: false });

    expect(takePreUpdateBackup('0.26.0', MONDAY).created).toBe(
      'workwise-before-update-2026-08-10-0900-0.26.0.db',
    );
  });

  it('keeps three, so a bad release noticed two updates later is still reachable', () => {
    addJob('Railing');
    for (const [day, version] of [
      ['10', '0.26.0'],
      ['11', '0.26.1'],
      ['12', '0.26.2'],
    ] as const) {
      takePreUpdateBackup(version, new Date(`2026-08-${day}T09:00:00+02:00`));
    }

    const fourth = takePreUpdateBackup('0.27.0', new Date('2026-08-13T09:00:00+02:00'));

    expect(fourth.removed).toEqual(['workwise-before-update-2026-08-10-0900-0.26.0.db']);
    expect(listPreUpdateBackups(backupsDir).map((backup) => backup.version)).toEqual([
      '0.27.0',
      '0.26.2',
      '0.26.1',
    ]);
  });

  it('leaves the weekly copies and their count alone', () => {
    addJob('Railing');
    takeAutomaticBackup(MONDAY);

    takePreUpdateBackup('0.26.0', MONDAY);

    expect(listAutomaticBackups(backupsDir).map((backup) => backup.name)).toEqual([
      'workwise-2026-08-10-0900.db',
    ]);
    // And the weekly one is still not due, so the pre-update copy did not count as this week's.
    expect(takeAutomaticBackup(MONDAY)).toMatchObject({ created: null, skipped: 'not-due' });
  });

  it('replaces its own earlier attempt when an update stays pending across launches', () => {
    // The updater re-offers a downloaded update every time the app opens, so the same version is
    // copied again and again. Each attempt spending a slot would erase every earlier way back in
    // three mornings — and the way back that matters is from the version actually installed.
    addJob('Railing');
    takePreUpdateBackup('0.24.0', new Date('2026-08-08T09:00:00+02:00'));
    const first = takePreUpdateBackup('0.26.0', MONDAY);

    addJob('Staircase');
    const second = takePreUpdateBackup('0.26.0', new Date('2026-08-11T09:00:00+02:00'));

    expect(second.removed).toEqual([first.created]);
    expect(listPreUpdateBackups(backupsDir).map((backup) => backup.version)).toEqual([
      '0.26.0',
      '0.24.0',
    ]);
    // And it is the FRESHER one, so the work done between the two attempts is not lost by restoring.
    const copy = new Database(path.join(backupsDir, second.created), { readonly: true });
    expect(copy.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 2 });
    copy.close();
  });

  it('never deletes the copy it has just taken, whatever the clock says', () => {
    addJob('Railing');
    for (const [day, version] of [
      ['10', '0.26.0'],
      ['11', '0.26.1'],
      ['12', '0.26.2'],
    ] as const) {
      takePreUpdateBackup(version, new Date(`2026-08-${day}T09:00:00+02:00`));
    }

    const result = takePreUpdateBackup('0.27.0', new Date('2025-01-01T09:00:00+02:00'));

    expect(fs.existsSync(path.join(backupsDir, result.created))).toBe(true);
    expect(result.removed).not.toContain(result.created);
    expect(listPreUpdateBackups(backupsDir)).toHaveLength(3);
  });

  it('refuses a version that could name a file somewhere else, and writes nothing', () => {
    addJob('Railing');

    expect(refusal(() => takePreUpdateBackup('../../calendar', MONDAY)).code).toBe(
      'backup-version-invalid',
    );
    expect(fs.existsSync(backupsDir)).toBe(false);
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

  it('keeps the two series apart, so each row says what it is', () => {
    addJob('Railing');
    takeAutomaticBackup(MONDAY);
    takePreUpdateBackup('0.26.0', A_WEEK_LATER);

    const list = listBackups();

    expect(list.backups.map((backup) => backup.name)).toEqual(['workwise-2026-08-10-0900.db']);
    expect(list.preUpdate.map((backup) => backup.version)).toEqual(['0.26.0']);
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

  it('brings the calendar back from a copy taken before an update', () => {
    // Without this the row would render, the confirmation would open, and the restore would always
    // be refused — a way back that only looks like one.
    addJob('Railing');
    const created = takePreUpdateBackup('0.26.0', MONDAY).created;
    addJob('Staircase');

    restoreBackup({ name: created });

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
