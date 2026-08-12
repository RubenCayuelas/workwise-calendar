/**
 * Domain types for the workshop scheduler, plus the row mappers that are the
 * only bridge between SQLite's shapes and the app's.
 *
 * The boundary is deliberate and narrow:
 *
 * - SQLite has no boolean. `locked` and `is_closed` are 0/1 INTEGERs on disk and
 *   real booleans above these mappers, so no call site ever branches on a number.
 * - SQLite stores durations as decimal hours, because hours are what the owner
 *   types and reads. In memory everything is INTEGER MINUTES (`startMinutes`,
 *   `durationMinutes`, `totalMinutes`), which is what keeps 2.5 h from drifting
 *   once it has been added and subtracted a few times. Convert back with
 *   `minutesToHours` from src/lib/dates.ts, at the edge, once.
 * - `date` is always a local shop `YYYY-MM-DD`; `NULL` text becomes `undefined`.
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
  /** The only exemption from auto-move. The owner can still move it by hand. */
  locked: boolean;
  /**
   * The duration on this row was set BY HAND (the bottom-edge drag), so the engine
   * must not re-derive it from the job's total. It ends the job's run there: the
   * remaining hours start on the next auto-fill day and the space freed on this one
   * goes to the jobs that follow in the queue.
   *
   * A flag, not a second copy of the minutes: `duration` stays the single source of
   * truth for how long the row is, so the two can never disagree. Cleared by anything
   * OTHER than a resize that changes the row's duration — see CLAUDE.md, *A Hand-Set
   * Duration*.
   */
  manualDuration: boolean;
  /**
   * A HUMAN put this row on this day, where the engine would otherwise have taken it
   * back: the Friday buffer or the weekend. The engine then treats it as a fixed
   * obstacle — it may never move it, exactly as it may never move a weekend row.
   *
   * It is what distinguishes "the engine parked overflow on Friday" (recovered as soon
   * as Mon-Thu frees up, which is what the colchón is for) from "the owner said do this
   * on Friday" (never recovered). Written by a drop onto a non-auto day and cleared by
   * a drop back onto Mon-Thu or by *back to automatic* — see CLAUDE.md, *A Hand-Placed
   * Row*.
   */
  handPlaced: boolean;
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
  createdAt: string;
  updatedAt: string;
}

/**
 * A whole-day exception: a holiday, a closed week, a day with different hours.
 * No Settings UI in v0.2, but the engine reads it.
 */
export interface DayOverride {
  date: string;
  /** Closed: no plannable time at all. */
  isClosed: boolean;
  /** Replaces the global auto-fill capacity for this day; `null` means "use the global one". */
  capacityHours: number | null;
  note?: string;
}

/**
 * The owner's configuration. Times stay `HH:mm` and capacities stay decimal
 * hours here because this record mirrors what the Settings form shows; use
 * `dayShapeFromSettings` in src/lib/settings.ts for the minutes the engine wants.
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
   * Auto-fill stop line, in hours: "fill less than the full shift so the shop can
   * leave early", never "work more than the shift covers". Capped at the sum of
   * the enabled periods and never a limit on manual placement.
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
 * `Settings` seen the way the engine and the calendar grid need it: minutes, and
 * with the visual margins resolved into the timeline they draw. Derived, never
 * stored — build it with `dayShapeFromSettings` in src/lib/settings.ts.
 */
export interface DayShape {
  /** One period, or two when the afternoon is enabled. Always in chronological order. */
  periods: WorkPeriod[];
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
  /** 0/1: the duration was set by hand and the engine may not re-derive it. */
  manual_duration: number;
  /** 0/1: a human put the row on this day and the engine may not recover it. */
  hand_placed: number;
  created_at: string;
  updated_at: string;
}

export interface GapRow {
  id: string;
  date: string;
  start_time: string;
  duration: number;
  reason: string | null;
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
    manualDuration: toBoolean(row.manual_duration),
    handPlaced: toBoolean(row.hand_placed),
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
    manual_duration: block.manualDuration ? 1 : 0,
    hand_placed: block.handPlaced ? 1 : 0,
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
