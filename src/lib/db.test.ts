import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, getDbPath, openDatabase } from './db';
import { DEFAULT_SETTINGS } from './settings';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'workwise-db-'));

afterEach(() => {
  closeDb();
  delete process.env.WORKWISE_DB_PATH;
});

describe('getDb', () => {
  it('creates the missing data directory instead of failing with SQLITE_CANTOPEN', () => {
    const dbPath = path.join(scratch, 'nested', 'data', 'calendar.db');
    process.env.WORKWISE_DB_PATH = dbPath;

    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);
    const db = getDb();

    expect(fs.existsSync(dbPath)).toBe(true);
    // Counted against the defaults rather than a literal: a key added to `Settings` and forgotten in
    // `serializeSettings` is exactly what this catches, and the number needs no maintenance.
    expect(db.prepare('SELECT COUNT(*) AS n FROM settings').get()).toEqual({
      n: Object.keys(DEFAULT_SETTINGS).length,
    });
  });

  it('opens and migrates exactly once, however many times it is called', () => {
    process.env.WORKWISE_DB_PATH = path.join(scratch, 'once', 'calendar.db');
    expect(getDb()).toBe(getDb());
  });

  it('sets the pragmas the schema relies on', () => {
    process.env.WORKWISE_DB_PATH = path.join(scratch, 'pragmas', 'calendar.db');
    const db = getDb();

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('defaults to ./data/calendar.db under the project root', () => {
    expect(getDbPath()).toBe(path.join(process.cwd(), 'data', 'calendar.db'));
  });

  it('refuses to open that file from a test, because opening it MIGRATES it', () => {
    // Measured, not hypothetical: on 2026-08-19 a mistyped argument let a trailing `db` parameter
    // fall back to its default and a data migration ran over the shop's real calendar.
    expect(() => openDatabase(path.join(process.cwd(), 'data', 'calendar.db'))).toThrow(/Refusing/);
    expect(() => getDb()).toThrow(/Refusing/);
  });
});

describe('the migration meets a database that already holds work', () => {
  it("opens the shop's existing file and leaves the rows it already has alone", () => {
    // `CREATE TABLE IF NOT EXISTS` is skipped wholesale on a table that exists, so a column
    // added later would never reach `data/calendar.db` — which is not thrown away between
    // versions. `ADDED_COLUMNS` is the path for that and is EMPTY today: both flags it once
    // carried have been retired (see `REMOVED_COLUMNS`), so what this pins is that opening
    // an older file adds nothing, drops nothing and touches no row.
    const dbPath = path.join(scratch, 'legacy', 'calendar.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, color TEXT NOT NULL,
        total_hours REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE blocks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        date TEXT NOT NULL, start_time TEXT NOT NULL,
        duration REAL NOT NULL CHECK (duration > 0),
        locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO projects (id, name, color, total_hours) VALUES ('p1', 'Staircase', '#249E30', 2);
      INSERT INTO blocks (id, project_id, date, start_time, duration)
        VALUES ('b1', 'p1', '2026-08-10', '08:00', 2);
    `);
    legacy.close();

    const db = openDatabase(dbPath);

    // The row survives exactly as it was, padlock included.
    expect(db.prepare('SELECT id, duration, locked FROM blocks').all()).toEqual([
      { id: 'b1', duration: 2, locked: 0 },
    ]);
    // And running the migration again is a no-op rather than a duplicate-column error.
    expect(() => openDatabase(dbPath).close()).not.toThrow();
    db.close();
  });

  it('turns both retired marks into PADLOCKED rows, and drops their columns', () => {
    // The shop's file holds both marks this app has retired, and the same argument settles
    // both: every row that carried one had been settled BY THE OWNER — a Friday, a weekend,
    // a margin, a length they drew — so freeing it would let the next recomposition move or
    // re-derive exactly the work they meant. They come out `locked`, which is the only mark
    // left and now means both things at once.
    const dbPath = path.join(scratch, 'retired-marks', 'calendar.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, color TEXT NOT NULL,
        total_hours REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE blocks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        date TEXT NOT NULL, start_time TEXT NOT NULL,
        duration REAL NOT NULL CHECK (duration > 0),
        locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
        manual_duration INTEGER NOT NULL DEFAULT 0 CHECK (manual_duration IN (0, 1)),
        hand_placed INTEGER NOT NULL DEFAULT 0 CHECK (hand_placed IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_blocks_date_start_time ON blocks (date, start_time);
      CREATE TRIGGER trg_blocks_updated_at
      AFTER UPDATE ON blocks FOR EACH ROW
      WHEN OLD.updated_at = NEW.updated_at
      BEGIN
        UPDATE blocks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;
      INSERT INTO projects (id, name, color, total_hours) VALUES ('p1', 'Staircase', '#249E30', 6);
      INSERT INTO projects (id, name, color, total_hours) VALUES ('p2', 'Door', '#249E30', 4);
      INSERT INTO blocks (id, project_id, date, start_time, duration, locked, manual_duration, hand_placed)
        VALUES ('viernes',   'p1', '2026-08-14', '10:00', 2, 0, 0, 1),
               ('bloqueado', 'p1', '2026-08-13', '08:00', 2, 1, 1, 0),
               ('medido',    'p2', '2026-08-12', '15:30', 2, 0, 1, 0),
               ('libre',     'p2', '2026-08-11', '08:00', 2, 0, 0, 0);
    `);
    legacy.close();

    const db = openDatabase(dbPath);

    const columns = db
      .prepare('PRAGMA table_info(blocks)')
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).not.toContain('hand_placed');
    expect(columns).not.toContain('manual_duration');

    // The row a human PLACED and the row a human SIZED both come out padlocked; the one
    // that already was stays; the free row is still free. Nothing else changed: same
    // dates, same starts, same durations.
    expect(db.prepare('SELECT id, locked, date, start_time, duration FROM blocks ORDER BY id').all()).toEqual([
      { id: 'bloqueado', locked: 1, date: '2026-08-13', start_time: '08:00', duration: 2 },
      { id: 'libre', locked: 0, date: '2026-08-11', start_time: '08:00', duration: 2 },
      { id: 'medido', locked: 1, date: '2026-08-12', start_time: '15:30', duration: 2 },
      { id: 'viernes', locked: 1, date: '2026-08-14', start_time: '10:00', duration: 2 },
    ]);
    // Idempotent: the columns are gone, so the second run has nothing to carry over.
    expect(() => openDatabase(dbPath).close()).not.toThrow();
    expect(db.prepare("SELECT locked FROM blocks WHERE id = 'libre'").get()).toEqual({ locked: 0 });
    db.close();
  });

  it('is safe on a database that never had the retired columns at all', () => {
    // The other path through `dropRemovedColumns`: a file created by THIS version. Both
    // carry-overs are skipped by `PRAGMA table_info`, so nothing runs and nothing is
    // padlocked by accident.
    const dbPath = path.join(scratch, 'fresh-schema', 'calendar.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const first = openDatabase(dbPath);
    first.exec(`
      INSERT INTO projects (id, name, color, total_hours) VALUES ('p1', 'Staircase', '#249E30', 2);
      INSERT INTO blocks (id, project_id, date, start_time, duration, locked)
        VALUES ('libre', 'p1', '2026-08-12', '08:00', 2, 0);
    `);
    first.close();

    const again = openDatabase(dbPath);
    expect(again.prepare('SELECT id, locked FROM blocks').all()).toEqual([{ id: 'libre', locked: 0 }]);
    again.close();
  });
});

describe('the gap migration: a duration that used to be clock minutes', () => {
  /**
   * The shop's own file, which is where this change came from: four `08:00 +11,5 h` "Fair" gaps —
   * 11.5 and not 10 because the lunch break was paid for — and one ordinary gap that crosses nothing.
   * The legacy file has no `data_migrations` table and no settings, so opening it is the real path:
   * the schema is created, the DEFAULTS ARE SEEDED, and only then does the data migration read the
   * shift it must cut at.
   */
  const legacyFile = (name: string, rows: string, extra = ''): string => {
    const dbPath = path.join(scratch, name, 'calendar.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE gaps (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, start_time TEXT NOT NULL,
        duration REAL NOT NULL CHECK (duration > 0), reason TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO gaps (id, date, start_time, duration, reason, created_at, updated_at) VALUES ${rows};
      ${extra}
    `);
    legacy.close();
    return dbPath;
  };

  const FERIA_WEEK = `
        ('feria-1', '2026-09-01', '08:00', 11.5, 'Fair',      '2026-08-01 09:00:00', '2026-08-01 09:00:00'),
        ('feria-2', '2026-09-02', '08:00', 11.5, 'Fair',      '2026-08-01 09:00:00', '2026-08-01 09:00:00'),
        ('feria-3', '2026-09-03', '08:00', 11.5, 'Fair',      '2026-08-01 09:00:00', '2026-08-01 09:00:00'),
        ('feria-4', '2026-09-04', '08:00', 11.5, 'Fair',      '2026-08-01 09:00:00', '2026-08-01 09:00:00'),
        ('corto',   '2026-08-24', '09:00', 1,    'Holiday', '2026-08-01 09:00:00', '2026-08-01 09:00:00')`;

  const shopFile = (name: string): string => legacyFile(name, FERIA_WEEK);

  const gapLines = (db: ReturnType<typeof openDatabase>): string[] =>
    (
      db
        .prepare('SELECT date, start_time, duration, reason FROM gaps ORDER BY date, start_time')
        .all() as Array<{ date: string; start_time: string; duration: number; reason: string }>
    ).map((row) => `${row.date} ${row.start_time} +${row.duration} ${row.reason}`);

  it('splits every gap that crossed the lunch break and leaves the others byte-identical', () => {
    const dbPath = shopFile('gaps-clock-minutes');
    const db = openDatabase(dbPath);

    // Each Fair row becomes the two rows it always was on screen, both keeping the reason. 6 + 4 is
    // 10 net hours, which is what the day really lost; the missing 1.5 h is the lunch break, unpaid for now.
    expect(gapLines(db)).toEqual([
      '2026-08-24 09:00 +1 Holiday',
      '2026-09-01 08:00 +6 Fair',
      '2026-09-01 15:30 +4 Fair',
      '2026-09-02 08:00 +6 Fair',
      '2026-09-02 15:30 +4 Fair',
      '2026-09-03 08:00 +6 Fair',
      '2026-09-03 15:30 +4 Fair',
      '2026-09-04 08:00 +6 Fair',
      '2026-09-04 15:30 +4 Fair',
    ]);

    // The gap that crossed nothing was not written at all: same id, same timestamps.
    expect(db.prepare("SELECT id, updated_at FROM gaps WHERE date = '2026-08-24'").get()).toEqual({
      id: 'corto',
      updated_at: '2026-08-01 09:00:00',
    });
    // The morning half keeps the row's identity, so nothing that referred to the gap is orphaned,
    // and the afternoon half is the same age as its other half.
    expect(db.prepare("SELECT id, created_at FROM gaps WHERE date = '2026-09-01' ORDER BY start_time").all()).toEqual([
      { id: 'feria-1', created_at: '2026-08-01 09:00:00' },
      { id: expect.any(String), created_at: '2026-08-01 09:00:00' },
    ]);
    // The two halves it made are ONE unit, so they are drawn joined and edited together.
    const feria = db
      .prepare("SELECT unit_id FROM gaps WHERE date = '2026-09-01' ORDER BY start_time")
      .all() as Array<{ unit_id: string }>;
    expect(feria[0].unit_id).toBe(feria[1].unit_id);
    // And the gap it did not touch is a unit of its own: two gaps are never fused by a migration.
    expect(db.prepare("SELECT unit_id FROM gaps WHERE id = 'corto'").get()).toEqual({
      unit_id: 'corto',
    });
    db.close();

    // Idempotent, and doubly so: every row now sits inside one window, AND both migrations are
    // recorded, so neither runs again against a shift the owner may have changed since.
    const again = openDatabase(dbPath);
    expect(gapLines(again)).toHaveLength(9);
    expect(again.prepare('SELECT name FROM data_migrations ORDER BY name').all()).toEqual([
      { name: '2026-08-19-gap-duration-is-net-minutes' },
      { name: '2026-08-19-gap-unit-ids' },
      { name: '2026-08-25-repaint-projects-onto-the-new-palette' },
    ]);
    again.close();
  });

  it('leaves a gap that crosses NO break exactly as it found it, losing no recorded time', () => {
    // Measured on 2026-08-19: both of these came back SHORTENED, because the migration wrote the old
    // interval INTERSECTED with the manual windows. An hour of `Madrugon` and an hour and a half of
    // `Noche` were deleted, which is not a change of units — it is losing what the owner recorded.
    // A row a shift no longer covers gets the same latitude a stranded block gets: it stays.
    const dbPath = legacyFile(
      'gaps-outside-the-windows',
      `
        ('madrugon', '2026-08-24', '06:00', 3,   'Madrugon',     '2026-08-01 09:00:00', '2026-08-01 09:00:00'),
        ('noche',    '2026-08-25', '19:00', 3,   'Noche',        '2026-08-01 09:00:00', '2026-08-01 09:00:00'),
        ('lunch break',   '2026-08-26', '14:15', 0.5, 'Lunch break larga', '2026-08-01 09:00:00', '2026-08-01 09:00:00')`,
    );
    const db = openDatabase(dbPath);

    expect(gapLines(db)).toEqual([
      '2026-08-24 06:00 +3 Madrugon',
      '2026-08-25 19:00 +3 Noche',
      // Wholly inside the lunch break, where a gap can no longer be recorded. Left as it is rather than
      // moved to 15:30, which would be the migration deciding a placement the owner never asked for.
      '2026-08-26 14:15 +0.5 Lunch break larga',
    ]);
    // Untouched means untouched: assigning a unit id is not an edit.
    expect(db.prepare('SELECT updated_at FROM gaps ORDER BY date').all()).toEqual([
      { updated_at: '2026-08-01 09:00:00' },
      { updated_at: '2026-08-01 09:00:00' },
      { updated_at: '2026-08-01 09:00:00' },
    ]);
    db.close();
  });

  it('re-pairs the halves the split already made on a file it has already run on', () => {
    // The shop's own database, which ran the split on 2026-08-19 before `unit_id` existed: the
    // marker is there, so the split must NOT run again, and the two halves of each Fair gap have
    // nothing left linking them but their date, their reason and the second they were written in.
    const dbPath = legacyFile(
      'gaps-already-split',
      `
        ('feria-am', '2026-09-01', '08:00', 6, 'Fair', '2026-08-01 09:00:00', '2026-08-01 09:00:00'),
        ('feria-pm', '2026-09-01', '15:30', 4, 'Fair', '2026-08-01 09:00:00', '2026-08-01 09:00:00'),
        ('otro',     '2026-09-01', '19:30', 1, 'Fair', '2026-08-02 11:00:00', '2026-08-02 11:00:00')`,
      `
      CREATE TABLE data_migrations (
        name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO data_migrations (name) VALUES ('2026-08-19-gap-duration-is-net-minutes');
    `,
    );
    const db = openDatabase(dbPath);

    const units = db
      .prepare('SELECT id, unit_id FROM gaps ORDER BY start_time')
      .all() as Array<{ id: string; unit_id: string }>;
    expect(units[0].unit_id).toBe(units[1].unit_id);
    // A gap written in another gesture keeps its own unit id even where it TOUCHES one of the halves
    // and carries the same reason: two gaps that merely touch are two gaps.
    expect(units[2].unit_id).toBe('otro');
    // The split did not run again: 6 h and 4 h, not re-cut, and the rows still 10 h between them.
    expect(gapLines(db)).toEqual([
      '2026-09-01 08:00 +6 Fair',
      '2026-09-01 15:30 +4 Fair',
      '2026-09-01 19:30 +1 Fair',
    ]);
    db.close();
  });

  it('is safe on a database that never had a crossing gap, and on an empty one', () => {
    const dbPath = path.join(scratch, 'gaps-no-crossing', 'calendar.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const first = openDatabase(dbPath);
    // Nothing to migrate on a brand-new file; every migration is still recorded, so none runs
    // again against a shift the owner may have changed in the meantime.
    expect(first.prepare('SELECT COUNT(*) AS n FROM data_migrations').get()).toEqual({ n: 3 });
    first.exec("INSERT INTO gaps (id, date, start_time, duration, reason) VALUES ('g1', '2026-08-24', '09:00', 1, 'Errands')");
    first.close();

    const again = openDatabase(dbPath);
    expect(gapLines(again)).toEqual(['2026-08-24 09:00 +1 Errands']);
    again.close();
  });
});

describe('the palette migration: a job painted from the retired swatch set', () => {
  const colours = (db: ReturnType<typeof openDatabase>): string[] =>
    (db.prepare('SELECT color FROM projects ORDER BY id').all() as Array<{ color: string }>).map(
      (row) => row.color,
    );

  it('repaints every job onto the new palette without ever merging two of them', () => {
    const dbPath = path.join(scratch, 'palette', 'calendar.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, color TEXT NOT NULL,
        total_hours REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO projects (id, name, color, total_hours) VALUES
        ('p1', 'Railing',   '#185FA5', 2),
        ('p2', 'Staircase', '#1D9E75', 2),
        ('p3', 'Door',      '#D85A30', 2),
        ('p4', 'Shutter',   '#534AB7', 2),
        ('p5', 'Grille',    '#A32D2D', 2),
        ('p6', 'Shed',      '#0F6E56', 2),
        ('p7', 'Casing',    '#D4537E', 2),
        ('p8', 'Capping',   '#5F5E5A', 2);
    `);
    legacy.close();

    const db = openDatabase(dbPath);
    // Each old value takes its own new one. The eight jobs the owner could tell apart before are
    // still eight the owner can tell apart, which a per-colour nearest lookup would have broken:
    // both retired greens would have found the single green there is now.
    expect(colours(db)).toEqual([
      '#3787D7',
      '#249E30',
      '#E86417',
      '#8E5DC6',
      '#C93136',
      '#9B8508',
      '#D62988',
      '#847B6C',
    ]);
    expect(new Set(colours(db)).size).toBe(8);
    db.close();

    // Recorded, so a job the owner has since repainted by hand is never repainted again — and a
    // value that is in BOTH palettes could not be double-mapped even if it were.
    const again = openDatabase(dbPath);
    again.prepare("UPDATE projects SET color = '#3787D7' WHERE id = 'p2'").run();
    again.close();
    const third = openDatabase(dbPath);
    expect(third.prepare("SELECT color FROM projects WHERE id = 'p2'").get()).toEqual({
      color: '#3787D7',
    });
    third.close();
  });

  it('leaves a colour it does not recognise exactly as it found it', () => {
    // Not the app's to guess at: an arbitrary hex reached the column some other way, and the
    // migration names the eight it retired and nothing else.
    const dbPath = path.join(scratch, 'palette-unknown', 'calendar.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, color TEXT NOT NULL,
        total_hours REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO projects (id, name, color, total_hours) VALUES ('p1', 'Railing', '#123456', 2);
    `);
    legacy.close();

    const db = openDatabase(dbPath);
    expect(colours(db)).toEqual(['#123456']);
    db.close();
  });
});

describe('openDatabase', () => {
  it('hands out an isolated, already-migrated database for tests', () => {
    const a = openDatabase(':memory:');
    const b = openDatabase(':memory:');
    a.prepare("INSERT INTO projects (id, name, color) VALUES ('p1', 'Staircase', '#249E30')").run();

    expect(a.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
    expect(b.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 0 });
  });
});
