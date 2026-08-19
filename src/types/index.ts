/**
 * Domain types, plus the row mappers that are the only bridge between SQLite's shapes and the app's.
 * SQLite has no boolean (0/1 on disk, real booleans above the mappers) and stores durations as decimal
 * hours; in memory everything is INTEGER MINUTES, converted back with `minutesToHours` at the edge,
 * once. `date` is always a local shop `YYYY-MM-DD`, and NULL text becomes `undefined`.
 */

import { hhmmToMinutes, hoursToMinutes, minutesToHHmm, minutesToHours } from '../lib/dates';

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** A job / work order. Its queue position is its calendar position — no sort column. */
export interface Project {
  id: string;
  name: string;
  /** Optional free text, edited in the job panel next to name and hours. */
  description?: string;
  /** Hex from the fixed `--ww-project-1..8` swatch set. Amber is reserved for the app. */
  color: string;
  /** Estimated total, in minutes. Invariant: equals the sum of the job's blocks. */
  totalMinutes: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * One slice of a job on the calendar. A block never straddles a non-working
 * interval, so work across the lunch break is two blocks of the same project.
 */
export interface Block {
  id: string;
  projectId: string;
  /** Local `YYYY-MM-DD`. */
  date: string;
  /** Minutes from midnight. */
  startMinutes: number;
  /** Net working minutes — a block is always a solid rectangle on the clock. */
  durationMinutes: number;
  /**
   * The ONE thing that fixes a row — its place and its length. The engine never moves it; the owner
   * still can, by hand. Set and cleared by the padlock, and by nothing else.
   */
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A hole in the schedule. Gaps are time: they consume the day's plannable minutes. */
export interface Gap {
  id: string;
  date: string;
  startMinutes: number;
  durationMinutes: number;
  /** Free text such as "Avería torno". May be absent. */
  reason?: string;
  /**
   * The gap this row is a PIECE of: the halves around the comida share one, and they carry one
   * reason between them. Two gaps that merely touch keep different ids and stay two gaps, which a
   * comparison of their reasons cannot say — the same sentence is written twice by a deleted job.
   */
  unitId: string;
  createdAt: string;
  updatedAt: string;
}

/** A whole-day exception: a holiday, a closed week, a day with different hours. No Settings UI. */
export interface DayOverride {
  date: string;
  /** Closed: no plannable time at all. */
  isClosed: boolean;
  /** Replaces the global auto-fill capacity for this day; `null` means "use the global one". */
  capacityHours: number | null;
  note?: string;
}

/**
 * The owner's configuration, mirroring what the Settings form shows: times stay `HH:mm` and capacities
 * stay decimal hours. `dayShapeFromSettings` gives the minutes the engine wants.
 */
export interface Settings {
  /** Morning period. Mandatory. */
  period1Start: string;
  period1End: string;
  /** Afternoon period. Only meaningful while `period2Enabled`. */
  period2Start: string;
  period2End: string;
  period2Enabled: boolean;
  /**
   * Auto-fill stop line, in hours: fill LESS than the full shift, never more. Capped at the sum of the
   * enabled periods, and never a limit on manual placement.
   */
  defaultDayCapacity: number;
  /** Hours drawn before period 1 / after the last period. Manual drag-drop only. Range 0-2. */
  visualMarginTop: number;
  visualMarginBottom: number;
  /** Auto-placement never creates blocks beyond this many weeks from today. */
  planningHorizonWeeks: number;
  /** One colour for every user-defined gap. */
  gapColor: string;
}

/** A contiguous stretch of working time, in minutes from midnight. */
export interface WorkPeriod {
  startMinutes: number;
  endMinutes: number;
}

/**
 * `Settings` as the engine and the calendar grid need it: minutes, with the visual margins resolved
 * into the timeline they draw. Derived, never stored — build it with `dayShapeFromSettings`.
 */
export interface DayShape {
  /** One period, or two when the afternoon is enabled. Always in chronological order. */
  periods: WorkPeriod[];
  /**
   * The same day as a HAND action sees it: the periods plus the visual margins, fused where they touch,
   * so the lunch break stays the only hole in the day. Derived by `manualWindowsOf` and carried next to
   * `periods` so a rule cannot be added to one view and forgotten in the other.
   */
  manualWindows: WorkPeriod[];
  /** Total working minutes the periods cover — the hard ceiling for capacity. */
  shiftMinutes: number;
  /** Auto-fill stop line. Never above `shiftMinutes`, never a limit on manual placement. */
  capacityMinutes: number;
  marginTopMinutes: number;
  marginBottomMinutes: number;
  /** Top and bottom of the rendered time axis, margins included. */
  timelineStartMinutes: number;
  timelineEndMinutes: number;
}

// ---------------------------------------------------------------------------
// Row shapes, exactly as SQLite returns them
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  color: string;
  total_hours: number;
  created_at: string;
  updated_at: string;
}

export interface BlockRow {
  id: string;
  project_id: string;
  date: string;
  start_time: string;
  duration: number;
  locked: number;
  created_at: string;
  updated_at: string;
}

export interface GapRow {
  id: string;
  date: string;
  start_time: string;
  duration: number;
  reason: string | null;
  /** NULL on a row written before the column existed; `mapGapRow` reads it as its own unit. */
  unit_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DayOverrideRow {
  date: string;
  is_closed: number;
  capacity_hours: number | null;
  note: string | null;
}

export interface SettingsRow {
  key: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Row mappers — the single conversion point in each direction
// ---------------------------------------------------------------------------

export function mapProjectRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: textOrUndefined(row.description),
    color: row.color,
    totalMinutes: hoursToMinutes(row.total_hours),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapBlockRow(row: BlockRow): Block {
  return {
    id: row.id,
    projectId: row.project_id,
    date: row.date,
    startMinutes: hhmmToMinutes(row.start_time),
    durationMinutes: hoursToMinutes(row.duration),
    locked: toBoolean(row.locked),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapGapRow(row: GapRow): Gap {
  return {
    id: row.id,
    date: row.date,
    startMinutes: hhmmToMinutes(row.start_time),
    durationMinutes: hoursToMinutes(row.duration),
    reason: textOrUndefined(row.reason),
    unitId: row.unit_id ?? row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapDayOverrideRow(row: DayOverrideRow): DayOverride {
  return {
    date: row.date,
    isClosed: toBoolean(row.is_closed),
    capacityHours: row.capacity_hours,
    note: textOrUndefined(row.note),
  };
}

/** The write side of `mapProjectRow`: minutes back to hours, `undefined` back to NULL. */
export function toProjectRow(project: Project): ProjectRow {
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? null,
    color: project.color,
    total_hours: minutesToHours(project.totalMinutes),
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}

/** The write side of `mapBlockRow`: minutes back to `HH:mm` + hours, boolean back to 0/1. */
export function toBlockRow(block: Block): BlockRow {
  return {
    id: block.id,
    project_id: block.projectId,
    date: block.date,
    start_time: minutesToHHmm(block.startMinutes),
    duration: minutesToHours(block.durationMinutes),
    locked: block.locked ? 1 : 0,
    created_at: block.createdAt,
    updated_at: block.updatedAt,
  };
}

/** The write side of `mapGapRow`. */
export function toGapRow(gap: Gap): GapRow {
  return {
    id: gap.id,
    date: gap.date,
    start_time: minutesToHHmm(gap.startMinutes),
    duration: minutesToHours(gap.durationMinutes),
    reason: gap.reason ?? null,
    unit_id: gap.unitId,
    created_at: gap.createdAt,
    updated_at: gap.updatedAt,
  };
}

/** The write side of `mapDayOverrideRow`. */
export function toDayOverrideRow(override: DayOverride): DayOverrideRow {
  return {
    date: override.date,
    is_closed: override.isClosed ? 1 : 0,
    capacity_hours: override.capacityHours,
    note: override.note ?? null,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** SQLite has no boolean: anything non-zero is true. */
function toBoolean(value: number): boolean {
  return value !== 0;
}

/** NULL and empty text both mean "not set" for optional free-text columns. */
function textOrUndefined(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
