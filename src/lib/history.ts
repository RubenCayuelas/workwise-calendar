/**
 * The undo timeline. A step is a whole calendar STATE rather than an inverse operation: the
 * reflow rewrites, deletes and recreates rows on every pass, so what a move DID is not
 * derivable from the move. `settings` is deliberately not part of a state — a settings save
 * empties the line instead of appearing in it.
 */

import { getDb, type Db } from './db';
import { prepared } from './repositories/statements';
import { assertProjectHours, runTransaction } from './scheduler';
import type { BlockRow, DayOverrideRow, GapRow, ProjectRow } from '../types';

/** How far back the owner can walk. The table holds one more row: the floor of the line. */
export const MAX_HISTORY_STEPS = 50;

/** One per gesture that writes. `settings` has no kind: it empties the line. */
export type UndoKind =
  | 'block.move'
  | 'block.resize'
  | 'block.lock'
  | 'block.split'
  | 'block.delete'
  | 'project.create'
  | 'project.update'
  | 'project.delete'
  | 'gap.create'
  | 'gap.update'
  | 'gap.delete'
  | 'absence.gaps'
  | 'absence.closeDays'
  | 'absence.reopen';

export interface HistoryIntent {
  readonly kind: UndoKind;
  /** The row or job the gesture named, so the step's sentence can find the job it is about. */
  readonly blockId?: string;
  readonly projectId?: string;
}

export interface HistoryStep {
  readonly kind: UndoKind;
  /** What the step's sentence interpolates, captured when the step was recorded. */
  readonly args: Record<string, string>;
}

export interface HistoryState {
  readonly undo: HistoryStep | null;
  readonly redo: HistoryStep | null;
  /** Nothing to undo BECAUSE a settings save started the line — a grey button with a reason. */
  readonly clearedBySettings: boolean;
}

export interface HistoryOutcome {
  readonly changed: boolean;
  readonly step: HistoryStep | null;
  /** The earliest day the restore touched: the week to put on screen. */
  readonly focusDate: string | null;
  /** The calendar had moved outside the line: nothing was restored and the line is gone. */
  readonly drifted: boolean;
}

// ---------------------------------------------------------------------------
// The state of the calendar
// ---------------------------------------------------------------------------

interface CalendarState {
  projects: ProjectRow[];
  blocks: BlockRow[];
  gaps: GapRow[];
  dayOverrides: DayOverrideRow[];
}

const PROJECT_COLUMNS = 'id, name, description, color, total_hours, created_at, updated_at';
const BLOCK_COLUMNS = 'id, project_id, date, start_time, duration, locked, created_at, updated_at';
const GAP_COLUMNS = 'id, date, start_time, duration, reason, unit_id, created_at, updated_at';
const OVERRIDE_COLUMNS = 'date, is_closed, capacity_hours, note';

/** Derived from the SELECT's own column list, so a capture and a restore cannot drift apart. */
function insertSql(table: string, columns: string): string {
  const names = columns.split(',').map((column) => column.trim());
  return `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map((name) => `@${name}`).join(', ')})`;
}

function captureState(db: Db): CalendarState {
  return {
    projects: prepared<ProjectRow>(db, `SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY id`).all(),
    blocks: prepared<BlockRow>(db, `SELECT ${BLOCK_COLUMNS} FROM blocks ORDER BY id`).all(),
    gaps: prepared<GapRow>(db, `SELECT ${GAP_COLUMNS} FROM gaps ORDER BY id`).all(),
    dayOverrides: prepared<DayOverrideRow>(
      db,
      `SELECT ${OVERRIDE_COLUMNS} FROM day_overrides ORDER BY date`,
    ).all(),
  };
}

/**
 * Rows are put back with every column named, `created_at` and `updated_at` included: the
 * repositories' inserts leave those to SQLite, and the queue's tiebreak is
 * `(date, start_time, created_at, id)` — a re-insert stamped `now` reorders the calendar. It
 * is a DELETE and an INSERT rather than an UPDATE for the same reason: the `updated_at`
 * triggers fire `WHEN OLD.updated_at = NEW.updated_at`, so an update restoring a row to its
 * own timestamp rewrites it.
 *
 * Nothing here validates: every row came out of this database, so it was already legal.
 */
function restoreState(db: Db, state: CalendarState): void {
  // Blocks before projects, and back again in the mirror order: `ON DELETE CASCADE` on
  // blocks.project_id would otherwise take rows this is about to put back.
  prepared(db, 'DELETE FROM blocks').run();
  prepared(db, 'DELETE FROM projects').run();
  prepared(db, 'DELETE FROM gaps').run();
  prepared(db, 'DELETE FROM day_overrides').run();

  const project = prepared(db, insertSql('projects', PROJECT_COLUMNS));
  for (const row of state.projects) project.run(row);
  const block = prepared(db, insertSql('blocks', BLOCK_COLUMNS));
  for (const row of state.blocks) block.run(row);
  const gap = prepared(db, insertSql('gaps', GAP_COLUMNS));
  for (const row of state.gaps) gap.run(row);
  const override = prepared(db, insertSql('day_overrides', OVERRIDE_COLUMNS));
  for (const row of state.dayOverrides) override.run(row);
}

/**
 * The state as the OWNER can see it. Timestamps are left out everywhere, and so is a block's
 * id: the reflow deletes and recreates rows on a pass that moved nothing, and a churned id is
 * not a change anybody asked to be able to undo.
 */
function canonical(state: CalendarState): string {
  return [
    ...state.projects.map(
      (row) => `P|${row.id}|${row.name}|${row.description ?? ''}|${row.color}|${row.total_hours}`,
    ),
    ...state.blocks.map(
      (row) => `B|${row.project_id}|${row.date}|${row.start_time}|${row.duration}|${row.locked}`,
    ),
    ...state.gaps.map(
      (row) =>
        `G|${row.id}|${row.date}|${row.start_time}|${row.duration}|${row.reason ?? ''}|${row.unit_id ?? ''}`,
    ),
    ...state.dayOverrides.map(
      (row) => `D|${row.date}|${row.is_closed}|${row.capacity_hours ?? ''}|${row.note ?? ''}`,
    ),
  ]
    .sort()
    .join('\n');
}

/** The earliest day the two states disagree about; `null` when they agree everywhere. */
function firstChangedDate(from: CalendarState, to: CalendarState): string | null {
  const byDate = (state: CalendarState): Map<string, string> => {
    const lines = new Map<string, string[]>();
    const push = (date: string, line: string): void => {
      const list = lines.get(date);
      if (list === undefined) lines.set(date, [line]);
      else list.push(line);
    };
    for (const row of state.blocks) {
      push(row.date, `B|${row.project_id}|${row.start_time}|${row.duration}|${row.locked}`);
    }
    for (const row of state.gaps) {
      push(row.date, `G|${row.start_time}|${row.duration}|${row.reason ?? ''}`);
    }
    for (const row of state.dayOverrides) {
      push(row.date, `D|${row.is_closed}|${row.capacity_hours ?? ''}|${row.note ?? ''}`);
    }
    return new Map([...lines].map(([date, list]) => [date, list.sort().join(';')]));
  };

  const before = byDate(from);
  const after = byDate(to);
  for (const date of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if ((before.get(date) ?? '') !== (after.get(date) ?? '')) return date;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------

interface EntryRow {
  seq: number;
  kind: string | null;
  label_args: string | null;
  state: string;
}

type LabelRow = Omit<EntryRow, 'state'>;

const ENTRY_COLUMNS = 'seq, kind, label_args, state';
/** Reading a label must never pull the state blobs with it. */
const LABEL_COLUMNS = 'seq, kind, label_args';

const IDLE: HistoryOutcome = { changed: false, step: null, focusDate: null, drifted: false };

/**
 * Runs one mutation as its own transaction AND records the step it turned out to be. Wraps
 * `runTransaction`, so the entry is written inside the same transaction as the rows it
 * describes: a refusal, a horizon rollback and `previewAbsence`'s deliberate rollback all
 * discard it with everything else.
 */
export function withHistory<T>(db: Db, intent: HistoryIntent, work: () => T): T {
  return runTransaction(db, () => {
    const before = captureState(db);
    const result = work();
    const after = captureState(db);
    if (canonical(before) !== canonical(after)) recordStep(db, intent, before, after);
    return result;
  });
}

/** Empties the line and makes the calendar as it stands its floor. Only a settings save does this. */
export function restartHistory(db: Db = getDb()): void {
  prepared(db, 'DELETE FROM history').run();
  insertEntry(db, 0, null, { clearedBy: 'settings' }, captureState(db));
}

export function undoLast(db: Db = getDb()): HistoryOutcome {
  return runTransaction(db, () => walk(db, 'back'));
}

export function redoNext(db: Db = getDb()): HistoryOutcome {
  return runTransaction(db, () => walk(db, 'forward'));
}

export function readHistoryState(db: Db = getDb()): HistoryState {
  const cursor = prepared<LabelRow>(
    db,
    `SELECT ${LABEL_COLUMNS} FROM history WHERE undone = 0 ORDER BY seq DESC LIMIT 1`,
  ).get();
  const below =
    cursor === undefined
      ? undefined
      : prepared<{ seq: number }>(
          db,
          'SELECT seq FROM history WHERE seq < ? ORDER BY seq DESC LIMIT 1',
        ).get(cursor.seq);
  const ahead = prepared<LabelRow>(
    db,
    `SELECT ${LABEL_COLUMNS} FROM history WHERE undone = 1 ORDER BY seq ASC LIMIT 1`,
  ).get();
  const floor = prepared<LabelRow>(
    db,
    `SELECT ${LABEL_COLUMNS} FROM history ORDER BY seq ASC LIMIT 1`,
  ).get();

  const undo = cursor === undefined || below === undefined ? null : stepOf(cursor);
  return {
    undo,
    redo: ahead === undefined ? null : stepOf(ahead),
    clearedBySettings: undo === null && argsOf(floor?.label_args).clearedBy === 'settings',
  };
}

function walk(db: Db, direction: 'back' | 'forward'): HistoryOutcome {
  const cursor = prepared<EntryRow>(
    db,
    `SELECT ${ENTRY_COLUMNS} FROM history WHERE undone = 0 ORDER BY seq DESC LIMIT 1`,
  ).get();
  if (cursor === undefined) return IDLE;

  const target =
    direction === 'back'
      ? prepared<EntryRow>(
          db,
          `SELECT ${ENTRY_COLUMNS} FROM history WHERE seq < ? ORDER BY seq DESC LIMIT 1`,
        ).get(cursor.seq)
      : prepared<EntryRow>(
          db,
          `SELECT ${ENTRY_COLUMNS} FROM history WHERE undone = 1 ORDER BY seq ASC LIMIT 1`,
        ).get();
  if (target === undefined) return IDLE;

  // Walking back UNDOES the cursor; walking forward REDOES the row it lands on.
  const named = direction === 'back' ? cursor : target;
  const step = stepOf(named);
  if (step === null) return IDLE;

  const current = captureState(db);
  // Only this line may have written the calendar since the cursor was recorded. A restore over
  // somebody else's change would lose it with nothing said, so the line gives way instead.
  if (canonical(current) !== canonical(parseState(cursor.state))) {
    prepared(db, 'DELETE FROM history').run();
    return { changed: false, step: null, focusDate: null, drifted: true };
  }

  const restored = parseState(target.state);
  restoreState(db, restored);
  prepared(db, 'UPDATE history SET undone = ? WHERE seq = ?').run(
    direction === 'back' ? 1 : 0,
    named.seq,
  );
  assertProjectHours(db);

  return {
    changed: true,
    step,
    focusDate: firstChangedDate(current, restored),
    drifted: false,
  };
}

function recordStep(
  db: Db,
  intent: HistoryIntent,
  before: CalendarState,
  after: CalendarState,
): void {
  prepared(db, 'DELETE FROM history WHERE undone = 1').run();
  const top = prepared<{ seq: number | null }>(db, 'SELECT MAX(seq) AS seq FROM history').get();
  let seq = top?.seq ?? null;
  if (seq === null) {
    // The first step of a line needs the state it started from, or it could not be undone.
    insertEntry(db, 0, null, null, before);
    seq = 0;
  }
  insertEntry(db, seq + 1, intent.kind, labelArgs(intent, before, after), after);
  prepared(
    db,
    'DELETE FROM history WHERE seq NOT IN (SELECT seq FROM history ORDER BY seq DESC LIMIT ?)',
  ).run(MAX_HISTORY_STEPS + 1);
}

function insertEntry(
  db: Db,
  seq: number,
  kind: UndoKind | null,
  args: Record<string, string> | null,
  state: CalendarState,
): void {
  prepared(db, 'INSERT INTO history (seq, kind, label_args, state) VALUES (?, ?, ?, ?)').run(
    seq,
    kind,
    args === null ? null : JSON.stringify(args),
    JSON.stringify(state),
  );
}

/** A job's name is read from BEFORE where it can be, so a deleted job is still named. */
function labelArgs(
  intent: HistoryIntent,
  before: CalendarState,
  after: CalendarState,
): Record<string, string> | null {
  const name = jobName(intent, before) ?? jobName(intent, after);
  return name === undefined ? null : { name };
}

function jobName(intent: HistoryIntent, state: CalendarState): string | undefined {
  if (intent.projectId !== undefined) {
    return state.projects.find((row) => row.id === intent.projectId)?.name;
  }
  if (intent.blockId !== undefined) {
    const block = state.blocks.find((row) => row.id === intent.blockId);
    if (block === undefined) return undefined;
    return state.projects.find((row) => row.id === block.project_id)?.name;
  }
  return undefined;
}

function stepOf(row: LabelRow): HistoryStep | null {
  if (row.kind === null) return null;
  return { kind: row.kind as UndoKind, args: argsOf(row.label_args) };
}

function argsOf(text: string | null | undefined): Record<string, string> {
  if (text === null || text === undefined) return {};
  return JSON.parse(text) as Record<string, string>;
}

function parseState(text: string): CalendarState {
  return JSON.parse(text) as CalendarState;
}
