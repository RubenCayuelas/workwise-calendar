import type { Db } from './db';
import { DEFAULT_SETTINGS, serializeSettings } from './settings';

/**
 * The whole schema, as one idempotent `CREATE ... IF NOT EXISTS` sequence — there is no released
 * version to migrate from, so this file IS the schema. Because `CREATE TABLE IF NOT EXISTS` is skipped
 * wholesale on a table that already exists on disk, a column added after the first run is also listed
 * in `ADDED_COLUMNS`, and one retired since in `REMOVED_COLUMNS`. On disk `duration` and `*_hours` are
 * decimal hours and `created_at` / `updated_at` are UTC; above the row mappers everything is local
 * dates and integer minutes.
 */
export function runMigrations(db: Db): void {
  db.exec(SCHEMA);
  addMissingColumns(db);
  dropRemovedColumns(db);
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
-- 'locked' is the ONLY exemption from auto-move, and the only thing that fixes a
-- row's position: the padlock the owner sets, and the padlock a drop onto a place
-- the engine would never choose by itself (a visual margin, the Friday buffer, the
-- weekend) sets for them. There is no manually_placed and no hand_placed flag.
-- There is no manual_duration flag either: a block is exactly as big as the room it
-- has, and the padlock is the one thing that fixes a length as well as a position.
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
 * Columns added to a table after its first release into `data/calendar.db`. A list rather than a
 * version counter because `PRAGMA table_info` gives the same answer however many times it runs.
 * SQLite's `ADD COLUMN` cannot add a NOT NULL column without a default, so a flag added here defaults
 * to the value meaning "as it was before". EMPTY IS THE CORRECT STATE, not a leftover.
 */
const ADDED_COLUMNS: ReadonlyArray<{ table: string; column: string; definition: string }> = [];

function addMissingColumns(db: Db): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    if (!hasColumn(db, table, column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

/**
 * Columns released into `data/calendar.db` and since RETIRED. `carryOver` runs while the column is still
 * there and in the same transaction as the drop, so a file either has the old column with its meaning
 * intact or the new shape with the meaning moved; both runs are idempotent. Both entries carry into
 * `locked` because the padlock is the only mark left: freeing those rows would let the next reflow move
 * — or re-derive the length of — the work the owner had settled by hand.
 */
const REMOVED_COLUMNS: ReadonlyArray<{ table: string; column: string; carryOver: string }> = [
  {
    table: 'blocks',
    column: 'hand_placed',
    carryOver: 'UPDATE blocks SET locked = 1 WHERE hand_placed = 1 AND locked = 0',
  },
  {
    table: 'blocks',
    column: 'manual_duration',
    carryOver: 'UPDATE blocks SET locked = 1 WHERE manual_duration = 1 AND locked = 0',
  },
];

function dropRemovedColumns(db: Db): void {
  for (const { table, column, carryOver } of REMOVED_COLUMNS) {
    if (!hasColumn(db, table, column)) continue;
    db.transaction(() => {
      db.exec(carryOver);
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    })();
  }
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return existing.some((row) => row.name === column);
}

/**
 * Seeds the factory settings; `INSERT OR IGNORE` keeps it idempotent and never overwrites a value the
 * owner has changed. Importing `DEFAULT_SETTINGS` keeps the defaults in one place and closes a cycle
 * (settings -> db -> migrations -> settings), safe only because every edge of it is dereferenced
 * inside a function body, never at module load.
 */
function seedDefaultSettings(db: Db): void {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const seed = db.transaction((entries: Array<[string, string]>) => {
    for (const [key, value] of entries) insert.run(key, value);
  });
  seed(Object.entries(serializeSettings(DEFAULT_SETTINGS)));
}
