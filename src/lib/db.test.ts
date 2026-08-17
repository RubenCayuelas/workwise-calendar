import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, getDbPath, openDatabase } from './db';

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
    expect(db.prepare('SELECT COUNT(*) AS n FROM settings').get()).toEqual({ n: 10 });
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
});

describe('the migration meets a database that already holds work', () => {
  it("adds a column the shop's file predates, keeping the rows it already has", () => {
    // `CREATE TABLE IF NOT EXISTS` is skipped wholesale on a table that exists, so a
    // column added later would never reach `data/calendar.db` — which is not thrown
    // away between versions. This is that path, with the pre-`manual_duration` schema.
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
      INSERT INTO projects (id, name, color, total_hours) VALUES ('p1', 'Escalera', '#1D9E75', 2);
      INSERT INTO blocks (id, project_id, date, start_time, duration)
        VALUES ('b1', 'p1', '2026-08-10', '08:00', 2);
    `);
    legacy.close();

    const db = openDatabase(dbPath);

    // The row survives, and it defaults to the value that means "as it was before":
    // the engine still owns its length.
    expect(db.prepare('SELECT id, duration, manual_duration FROM blocks').all()).toEqual([
      { id: 'b1', duration: 2, manual_duration: 0 },
    ]);
    // And running the migration again is a no-op rather than a duplicate-column error.
    expect(() => openDatabase(dbPath).close()).not.toThrow();
    db.close();
  });

  it('turns the retired `hand_placed` rows into PADLOCKED ones, and drops the column', () => {
    // The shop's file holds the third mark this version removes. Every row that carried it
    // was pinned BY THE OWNER — a Friday, a weekend, a margin — so freeing it would let the
    // next recomposition move exactly the work they had placed on purpose. It comes out
    // locked instead, which is what the mark now means everywhere else.
    const dbPath = path.join(scratch, 'hand-placed', 'calendar.db');
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
      INSERT INTO projects (id, name, color, total_hours) VALUES ('p1', 'Escalera', '#1D9E75', 6);
      INSERT INTO blocks (id, project_id, date, start_time, duration, locked, manual_duration, hand_placed)
        VALUES ('viernes',   'p1', '2026-08-14', '10:00', 2, 0, 0, 1),
               ('bloqueado', 'p1', '2026-08-13', '08:00', 2, 1, 1, 0),
               ('libre',     'p1', '2026-08-12', '08:00', 2, 0, 0, 0);
    `);
    legacy.close();

    const db = openDatabase(dbPath);

    expect(db.prepare('PRAGMA table_info(blocks)').all().map((row) => (row as { name: string }).name)).not.toContain(
      'hand_placed',
    );
    // The pinned row is padlocked; the padlock and the ruler that were already there are
    // untouched; the free row is still free.
    expect(db.prepare('SELECT id, locked, manual_duration FROM blocks ORDER BY id').all()).toEqual([
      { id: 'bloqueado', locked: 1, manual_duration: 1 },
      { id: 'libre', locked: 0, manual_duration: 0 },
      { id: 'viernes', locked: 1, manual_duration: 0 },
    ]);
    // Idempotent: the column is gone, so the second run has nothing to carry over.
    expect(() => openDatabase(dbPath).close()).not.toThrow();
    expect(db.prepare("SELECT locked FROM blocks WHERE id = 'libre'").get()).toEqual({ locked: 0 });
    db.close();
  });
});

describe('openDatabase', () => {
  it('hands out an isolated, already-migrated database for tests', () => {
    const a = openDatabase(':memory:');
    const b = openDatabase(':memory:');
    a.prepare("INSERT INTO projects (id, name, color) VALUES ('p1', 'Escalera', '#1D9E75')").run();

    expect(a.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
    expect(b.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 0 });
  });
});
