import type { Db } from './db';
import { DEFAULT_SETTINGS, serializeSettings } from './settings';

/**
 * The whole schema, as one idempotent `CREATE ... IF NOT EXISTS` sequence.
 *
 * There is no released version to migrate from, so there is no migration
 * framework either: this file IS the schema. When it changes before release,
 * delete `data/calendar.db` and let it be rebuilt.
 *
 * Two conventions worth knowing:
 *
 * - `date` / `start_time` are LOCAL shop values (`YYYY-MM-DD`, `HH:mm`) produced
 *   by `src/lib/dates.ts`. `created_at` / `updated_at` are SQLite's
 *   `CURRENT_TIMESTAMP`, which is UTC — never derive a calendar day from them.
 * - `duration` and `*_hours` are decimal hours, because that is what the user
 *   types and reads. Everything above the row mappers works in integer minutes.
 */
export function runMigrations(db: Db): void {
  db.exec(SCHEMA);
  seedDefaultSettings(db);
}

const SCHEMA = `
-- A job / work order. No status, no deadline, no client: out of scope.
-- Queue order is derived from calendar position, so there is no sort column.
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  color       TEXT NOT NULL,
  total_hours REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A slice of a project sitting on the calendar. One project has many blocks.
-- A block never straddles a non-working interval: work across lunch is two rows.
-- 'locked' is the only exemption from auto-move; there is no manually_placed flag.
CREATE TABLE IF NOT EXISTS blocks (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  start_time TEXT NOT NULL,
  duration   REAL NOT NULL CHECK (duration > 0),
  locked     INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A hole in the schedule (maintenance, breakdown, admin). Gaps are time: they
-- consume the day's plannable hours exactly like locked work does.
CREATE TABLE IF NOT EXISTS gaps (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  start_time TEXT NOT NULL,
  duration   REAL NOT NULL CHECK (duration > 0),
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Key/value configuration. Everything is TEXT on disk; src/lib/settings.ts is
-- the only place allowed to know that, and hands out a typed Settings object.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Whole-day exceptions: holidays, closed weeks, a one-off day with other hours.
-- No Settings UI in v0.2, but the engine reads it, so holidays are a row away
-- instead of a migration away. NULL capacity_hours means "use the global one".
CREATE TABLE IF NOT EXISTS day_overrides (
  date           TEXT PRIMARY KEY,
  is_closed      INTEGER NOT NULL DEFAULT 0 CHECK (is_closed IN (0, 1)),
  capacity_hours REAL,
  note           TEXT
);

-- The engine reads a week at a time in calendar order; the queue order IS
-- (date, start_time), so this index serves both the read and the sort.
CREATE INDEX IF NOT EXISTS idx_blocks_date_start_time ON blocks (date, start_time);
CREATE INDEX IF NOT EXISTS idx_blocks_project_id     ON blocks (project_id);
CREATE INDEX IF NOT EXISTS idx_gaps_date             ON gaps (date);

-- DEFAULT CURRENT_TIMESTAMP only fires on INSERT, so updated_at needs triggers.
-- The WHEN guard lets a caller set updated_at explicitly and be left alone; the
-- nested UPDATE does not re-fire the trigger because SQLite's recursive_triggers
-- pragma is off by default.
CREATE TRIGGER IF NOT EXISTS trg_projects_updated_at
AFTER UPDATE ON projects FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at
BEGIN
  UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_blocks_updated_at
AFTER UPDATE ON blocks FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at
BEGIN
  UPDATE blocks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_gaps_updated_at
AFTER UPDATE ON gaps FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at
BEGIN
  UPDATE gaps SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_settings_updated_at
AFTER UPDATE ON settings FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at
BEGIN
  UPDATE settings SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
END;
`;

/**
 * Seeds the factory settings. `INSERT OR IGNORE` keeps it idempotent and never
 * overwrites a value the owner has changed.
 *
 * The serialised shape is defined by DEFAULT_SETTINGS in src/lib/settings.ts;
 * it is imported here so the defaults live in exactly one place. That closes an
 * import cycle (settings -> db -> migrations -> settings), which is safe because
 * every edge of it is dereferenced inside a function body, never at module load.
 */
function seedDefaultSettings(db: Db): void {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const seed = db.transaction((entries: Array<[string, string]>) => {
    for (const [key, value] of entries) insert.run(key, value);
  });
  seed(Object.entries(serializeSettings(DEFAULT_SETTINGS)));
}
