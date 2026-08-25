import { hhmmToMinutes, hoursToMinutes, minutesToHHmm, minutesToHours } from './dates';
import type { Db } from './db';
import { newId } from './ids';
import { adjacentInWindows } from './manualWindow';
import { DEFAULT_SETTINGS, dayShapeFromSettings, readSettings, serializeSettings } from './settings';
import type { WorkPeriod } from '../types';

/**
 * The whole schema, as one idempotent `CREATE ... IF NOT EXISTS` sequence — there is no released
 * version to migrate from, so this file IS the schema. Because `CREATE TABLE IF NOT EXISTS` is skipped
 * wholesale on a table that already exists on disk, a column added after the first run is also listed
 * in `ADDED_COLUMNS`, and one retired since in `REMOVED_COLUMNS`. On disk `duration` and `*_hours` are
 * decimal hours and `created_at` / `updated_at` are UTC; above the row mappers everything is local
 * dates and integer minutes.
 *
 * `DATA_MIGRATIONS` is the fourth kind: a change to what the stored NUMBERS mean, which no `PRAGMA`
 * can see. Those run last, because one of them reads the settings and the defaults are seeded above.
 */
export function runMigrations(db: Db): void {
  db.exec(SCHEMA);
  addMissingColumns(db);
  dropRemovedColumns(db);
  seedDefaultSettings(db);
  runDataMigrations(db);
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
-- consume the day's plannable hours exactly like locked work does. 'duration' is
-- NET working minutes on disk too, so a gap across the lunch break is two rows sharing
-- one unit_id and no stored row of either table straddles a non-working interval.
-- unit_id is what says the two halves are ONE gap; NULL means the row is its own
-- unit, which is how a row written before the column reads. Two gaps that merely
-- touch keep different unit_ids and are never merged.
CREATE TABLE IF NOT EXISTS gaps (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  start_time TEXT NOT NULL,
  duration   REAL NOT NULL CHECK (duration > 0),
  reason     TEXT,
  unit_id    TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The data migrations that have already run. A structural change is guarded by
-- PRAGMA table_info, which asks the file itself; a change to what a stored NUMBER
-- MEANS leaves no trace to ask about, so it is recorded here and runs once.
CREATE TABLE IF NOT EXISTS data_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Key/value configuration. Everything is TEXT on disk; src/lib/settings.ts is
-- the only place allowed to know that, and hands out a typed Settings object.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The undo timeline: a line of whole-calendar STATES, one row per request that changed
-- something. The lowest seq is the floor — restorable, not undoable — and every later row
-- is the calendar AFTER the mutation its 'kind' names. 'undone = 1' marks the redo tail,
-- so the cursor is the highest seq with undone = 0. 'state' is JSON: projects, blocks,
-- gaps and day_overrides, ids and timestamps verbatim; never settings, which is why a
-- settings save empties this table instead of appearing in it. Emptied when the database
-- is opened, so a line lasts exactly one run of the app.
-- 'label_args' holds what the step's sentence interpolates, and on a FLOOR written by a
-- settings save it holds {"clearedBy":"settings"} instead: an empty undo with a reason.
-- 'fingerprint' is that same state as the OWNER sees it — no timestamps, no block ids — so both
-- guards (has the calendar moved outside the line? did this write change anything?) are a string
-- comparison and never a parse of the blob. Safe to store because the table is emptied on open, so
-- a change to how the fingerprint is computed can never meet a row written under the old one.
CREATE TABLE IF NOT EXISTS history (
  seq         INTEGER PRIMARY KEY,
  kind        TEXT,
  label_args  TEXT,
  state       TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  undone      INTEGER NOT NULL DEFAULT 0 CHECK (undone IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
 * to the value meaning "as it was before"; a column whose value is per-row and cannot be a constant
 * is added NULLABLE and filled by a data migration, which is where the evidence to fill it lives.
 */
const ADDED_COLUMNS: ReadonlyArray<{ table: string; column: string; definition: string }> = [
  { table: 'gaps', column: 'unit_id', definition: 'TEXT' },
];

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

// ---------------------------------------------------------------------------
// Data migrations
// ---------------------------------------------------------------------------

/**
 * Changes to the MEANING of stored values. Each runs at most once, in one transaction with the row that
 * records it, so a failure leaves the file with the old meaning intact and the migration pending.
 * Append-only: a name that has been released must never be reused.
 */
const DATA_MIGRATIONS: ReadonlyArray<{ name: string; run: (db: Db) => void }> = [
  { name: '2026-08-19-gap-duration-is-net-minutes', run: splitGapsAtBreaks },
  { name: '2026-08-19-gap-unit-ids', run: assignGapUnitIds },
  { name: '2026-08-25-repaint-projects-onto-the-new-palette', run: repaintProjectColors },
];

function runDataMigrations(db: Db): void {
  const applied = db.prepare('SELECT name FROM data_migrations').all() as Array<{ name: string }>;
  const done = new Set(applied.map((row) => row.name));

  for (const migration of DATA_MIGRATIONS) {
    if (done.has(migration.name)) continue;
    db.transaction(() => {
      migration.run(db);
      db.prepare('INSERT INTO data_migrations (name) VALUES (?)').run(migration.name);
    })();
  }
}

/** A gap exactly as it is on disk, before the change of meaning. */
interface StoredGapRow {
  id: string;
  date: string;
  start_time: string;
  duration: number;
  reason: string | null;
  unit_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A gap's `duration` was CLOCK minutes; it is NET working minutes now. IT SPLITS ONLY A GAP THAT
 * CROSSES A BREAK BETWEEN TWO WINDOWS, cutting it at that break, and leaves every other row exactly as
 * it found it: the shop's four `08:00 +11,5 h` "Feria" rows become `08:00 +6 h` and `15:30 +4 h`, both
 * keeping the reason, while `06:00 +3 h` keeps its three hours and `14:15 +0,5 h` — a gap wholly inside
 * the lunch break, where a gap can no longer be recorded — keeps its half hour where it is.
 *
 * It clips nothing, deletes nothing and anchors nothing, because those all lose what the owner
 * RECORDED, and a row a shift no longer covers has the same standing as a block a settings change
 * stranded: still there, still editable, never rewritten behind them. Intersecting the old interval
 * with the windows did clip, measured: an hour of `06:00 +3 h` and ninety minutes of `19:00 +3 h`.
 *
 * IT READS THE CURRENT SHIFT, because a stored gap carries no record of the one it was typed under.
 * Hence its place in `runMigrations`, after the defaults are seeded, and hence running once: a later
 * change to the shift must not silently re-cut gaps the owner has since put where they want them.
 */
function splitGapsAtBreaks(db: Db): void {
  const windows = dayShapeFromSettings(readSettings(db)).manualWindows;
  if (windows.length === 0) return;

  const rows = db
    .prepare('SELECT id, date, start_time, duration, reason, unit_id, created_at, updated_at FROM gaps')
    .all() as StoredGapRow[];

  const update = db.prepare('UPDATE gaps SET start_time = ?, duration = ?, unit_id = ? WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO gaps (id, date, start_time, duration, reason, unit_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of rows) {
    const startMinutes = hhmmToMinutes(row.start_time);
    const endMinutes = startMinutes + hoursToMinutes(row.duration);
    const pieces = cutAtCrossedBreaks(startMinutes, endMinutes, windows);
    if (pieces.length === 1) continue;

    // The pieces of one gap are one unit, and the morning half keeps the row's identity so nothing
    // that referred to the gap is orphaned.
    const unitId = row.unit_id ?? row.id;
    const [first, ...rest] = pieces;
    update.run(
      minutesToHHmm(first.startMinutes),
      minutesToHours(first.endMinutes - first.startMinutes),
      unitId,
      row.id,
    );
    for (const piece of rest) {
      // The original `created_at`: the halves of one gap are the same age.
      insert.run(
        newId(),
        row.date,
        minutesToHHmm(piece.startMinutes),
        minutesToHours(piece.endMinutes - piece.startMinutes),
        row.reason,
        unitId,
        row.created_at,
      );
    }
  }
}

/**
 * `[from, to)` cut at every break between two windows it holds minutes on BOTH sides of. One piece
 * back — the interval itself — when it crosses none, whether it lies inside a window, inside a break or
 * outside the shift altogether: only a straddle is a shape the new units cannot express.
 */
function cutAtCrossedBreaks(from: number, to: number, windows: readonly WorkPeriod[]): WorkPeriod[] {
  const ordered = [...windows].sort((a, b) => a.startMinutes - b.startMinutes);
  const pieces: WorkPeriod[] = [];
  let start = from;

  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const breakStart = ordered[index].endMinutes;
    const breakEnd = ordered[index + 1].startMinutes;
    if (breakEnd <= breakStart) continue;
    if (start >= breakStart || to <= breakEnd) continue;
    pieces.push({ startMinutes: start, endMinutes: breakStart });
    start = breakEnd;
  }

  pieces.push({ startMinutes: start, endMinutes: to });
  return pieces;
}

/**
 * Fills `unit_id` on every row that predates the column. Each row is its own unit, EXCEPT rows the
 * split above already made: same day, same reason, written in the same second and with nothing
 * workable between them. That signature is all the evidence a file the split has already run on has
 * left — the shop's own, migrated on 2026-08-19 before this column existed — and it is what keeps the
 * two halves of each `Feria` gap one unit on screen instead of two.
 *
 * Two gaps the OWNER made are never fused by it: they touch at a minute, not in a second.
 */
function assignGapUnitIds(db: Db): void {
  const windows = dayShapeFromSettings(readSettings(db)).manualWindows;
  const rows = db
    .prepare(
      `SELECT id, date, start_time, duration, reason, unit_id, created_at, updated_at FROM gaps
        WHERE unit_id IS NULL ORDER BY date, start_time, id`,
    )
    .all() as StoredGapRow[];

  const stamp = db.prepare('UPDATE gaps SET unit_id = ? WHERE id = ?');
  // `trg_gaps_updated_at` bumps `updated_at` on any UPDATE that leaves it equal to what it was, so it
  // is written back in a SECOND statement, where the two values differ and the trigger stays quiet.
  // Assigning a unit id is bookkeeping, not an edit of the gap.
  const restore = db.prepare('UPDATE gaps SET updated_at = ? WHERE id = ?');

  let previous: { row: StoredGapRow; unitId: string; endMinutes: number } | undefined;
  for (const row of rows) {
    const startMinutes = hhmmToMinutes(row.start_time);
    const endMinutes = startMinutes + hoursToMinutes(row.duration);
    const halvesOfOne =
      previous !== undefined &&
      previous.row.date === row.date &&
      previous.row.reason === row.reason &&
      previous.row.created_at === row.created_at &&
      adjacentInWindows(windows, previous.endMinutes, startMinutes);

    const unitId = halvesOfOne && previous !== undefined ? previous.unitId : row.id;
    stamp.run(unitId, row.id);
    restore.run(row.updated_at, row.id);
    previous = { row, unitId, endMinutes };
  }
}

/**
 * The swatch set was replaced wholesale, so every stored `projects.color` names a value the picker no
 * longer offers: the grid would go on painting the old hex while the swatch strip showed nothing
 * selected, and the two would disagree about a job until someone repainted it by hand.
 *
 * Each old value moves to the nearest new one in CIE Lab, and the mapping is a BIJECTION — the
 * assignment with the smallest total distance, not a nearest-neighbour lookup per colour. Two jobs the
 * owner had told apart must not come out the same colour, which is what a per-colour lookup does when
 * the two greens both find the one green there is now. That pair is the one visible jump: the old dark
 * green has no counterpart in a palette with a single green, so it takes the slot nothing else claims.
 *
 * One UPDATE with one CASE, so every row is matched against the OLD values exactly once. Applying the
 * pairs one at a time would chain — a row repainted by an early pair being matched again by a later
 * one — and it is only safe here because no new value is also an old one.
 */
function repaintProjectColors(db: Db): void {
  const PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['#185FA5', '#3087DF'],
    ['#1D9E75', '#1EA42B'],
    ['#D85A30', '#ED6212'],
    ['#534AB7', '#8D56CD'],
    ['#A32D2D', '#D1292F'],
    ['#0F6E56', '#C0B002'],
    ['#D4537E', '#DE2189'],
    ['#5F5E5A', '#867B69'],
  ];

  const cases = PAIRS.map(() => 'WHEN UPPER(color) = ? THEN ?').join(' ');
  db.prepare(
    `UPDATE projects SET color = CASE ${cases} ELSE color END
     WHERE UPPER(color) IN (${PAIRS.map(() => '?').join(', ')})`,
  ).run(...PAIRS.flat(), ...PAIRS.map(([from]) => from));
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
