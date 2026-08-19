import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations';

/** The database handle. `better-sqlite3` is synchronous — no promise plumbing anywhere. */
export type Db = Database.Database;

/** Kept in a module-level cache so the file is opened and migrated exactly once. */
let cached: Db | null = null;

/** `WORKWISE_DB_PATH` lets tests point at a throwaway file or `:memory:`. */
export function getDbPath(): string {
  return process.env.WORKWISE_DB_PATH ?? shopDbPath();
}

function shopDbPath(): string {
  return path.join(process.cwd(), 'data', 'calendar.db');
}

/**
 * The one accessor, lazy and idempotent. Lazy on purpose: at module load it would run the
 * migrations during `next build`.
 */
export function getDb(): Db {
  if (!cached) {
    cached = openDatabase(getDbPath());
  }
  return cached;
}

/** Opens and migrates a database without touching the cache. Tests use `:memory:`. */
export function openDatabase(dbPath: string): Db {
  // UNDER VITEST THE SHOP'S OWN FILE IS OFF LIMITS, because opening it MIGRATES it. One mistyped
  // argument — a `Db` passed where a date belonged, letting the trailing `db` parameter fall back to
  // its default — was enough to run a data migration over the real calendar on 2026-08-19. A test
  // reaching the default path is a test that forgot `WORKWISE_DB_PATH`, so it is refused rather than
  // served.
  if (process.env.VITEST !== undefined && path.resolve(dbPath) === shopDbPath()) {
    throw new Error(
      'Refusing to open data/calendar.db from a test: point WORKWISE_DB_PATH at a scratch file or use ":memory:"',
    );
  }

  if (dbPath !== ':memory:') {
    // SQLite will not create the directory: opening would fail with SQLITE_CANTOPEN.
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new Database(dbPath);
  // ON DELETE CASCADE on blocks.project_id is inert without this.
  db.pragma('foreign_keys = ON');
  // WAL keeps a long recomposition from blocking reads; a no-op in memory.
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
