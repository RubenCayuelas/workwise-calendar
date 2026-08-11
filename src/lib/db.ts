import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations';

/**
 * The database handle type. `better-sqlite3` is synchronous, so there is no
 * promise plumbing anywhere: a route handler reads rows and returns them.
 */
export type Db = Database.Database;

/** Kept in a module-level cache so the file is opened and migrated exactly once. */
let cached: Db | null = null;

/**
 * Where the database lives. `WORKWISE_DB_PATH` exists so tests can point at a
 * throwaway file or `:memory:` without touching the shop's data.
 */
export function getDbPath(): string {
  return process.env.WORKWISE_DB_PATH ?? path.join(process.cwd(), 'data', 'calendar.db');
}

/**
 * The one accessor. Lazy and idempotent: the first call creates `data/`, opens
 * the file, sets the pragmas and runs the migrations; every later call returns
 * the same handle.
 *
 * Lazy on purpose — doing this at module load would run migrations during
 * `next build`, which has no business writing to the shop's database.
 */
export function getDb(): Db {
  if (!cached) {
    cached = openDatabase(getDbPath());
  }
  return cached;
}

/**
 * Opens a database and brings it fully up to date, without touching the cache.
 * Use it in tests to get an isolated, migrated database per case:
 * `openDatabase(':memory:')`.
 */
export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    // A clean checkout has no data/ directory, and SQLite will not create one:
    // opening would fail with SQLITE_CANTOPEN.
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new Database(dbPath);
  // ON DELETE CASCADE on blocks.project_id is inert without this.
  db.pragma('foreign_keys = ON');
  // WAL keeps a long recomposition transaction from blocking reads. It is a
  // no-op on an in-memory database, which has no journal file to keep.
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  return db;
}

/** Closes the cached handle, if any. For tests and for a clean shutdown. */
export function closeDb(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}
