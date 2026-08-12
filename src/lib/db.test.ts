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
