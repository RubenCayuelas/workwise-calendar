import fs from 'fs';
import os from 'os';
import path from 'path';
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

describe('openDatabase', () => {
  it('hands out an isolated, already-migrated database for tests', () => {
    const a = openDatabase(':memory:');
    const b = openDatabase(':memory:');
    a.prepare("INSERT INTO projects (id, name, color) VALUES ('p1', 'Escalera', '#1D9E75')").run();

    expect(a.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
    expect(b.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 0 });
  });
});
