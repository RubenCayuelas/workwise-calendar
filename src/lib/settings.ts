/**
 * The typed settings repository.
 *
 * The `settings` table is key/value TEXT: `'true'`, `'10'`, `'08:00'`. This module
 * is the only place that knows it. Everything else asks for a `Settings` object
 * with real booleans and numbers, so the storage format is an implementation
 * detail rather than a trap at every call site.
 *
 * Two paths, on purpose:
 *
 * - Reading repairs. `readSettings` never throws: a missing or corrupt value
 *   falls back to that key's default, and an inconsistent combination is repaired.
 *   A hand-edited row must not be able to take the calendar down.
 * - Writing rejects. `writeSettings` throws `SettingsValidationError` on anything
 *   malformed or out of range, so the Settings form can point at the field.
 *
 * The single exception is `defaultDayCapacity`, which is always *re-capped*
 * instead of rejected. It is a stop line derived from the shift, so shortening
 * the periods or switching the afternoon off has to pull it down by itself —
 * per CLAUDE.md, "re-capped automatically when period times change".
 */

import { getDb, type Db } from './db';
import {
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  hhmmToMinutes,
  hoursToMinutes,
  minutesToHours,
} from './dates';
import type { DayShape, Settings, SettingsRow, WorkPeriod } from '../types';

/**
 * Factory configuration: the split shift the workshop actually runs.
 * `gapColor` matches `--ww-gap-fill` in public/brand/workwise-tokens.css.
 */
export const DEFAULT_SETTINGS: Settings = {
  period1Start: '08:00',
  period1End: '14:00',
  period2Start: '15:30',
  period2End: '19:30',
  period2Enabled: true,
  defaultDayCapacity: 10,
  visualMarginTop: 1,
  visualMarginBottom: 1,
  planningHorizonWeeks: 8,
  gapColor: '#D3D1C7',
};

/** Visual margins are 0-2 hours each: enough for an exceptional early start, not a second shift. */
export const MIN_MARGIN_HOURS = 0;
export const MAX_MARGIN_HOURS = 2;

/** The horizon bounds every placement loop, so it needs a floor and a ceiling. */
export const MIN_HORIZON_WEEKS = 1;
export const MAX_HORIZON_WEEKS = 104;

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Thrown by `writeSettings`; `field` is the key the Settings form should highlight. */
export class SettingsValidationError extends Error {
  readonly field: keyof Settings;

  constructor(field: keyof Settings, message: string) {
    super(message);
    this.name = 'SettingsValidationError';
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

/** The current configuration, with every missing or corrupt value repaired. */
export function readSettings(db: Db = getDb()): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as SettingsRow[];
  const stored: Record<string, string> = {};
  for (const row of rows) stored[row.key] = row.value;
  return normalizeSettings(stored);
}

/**
 * Merges `partial` over the stored configuration, validates it and saves it in
 * one transaction. Returns the configuration as it now stands — which may differ
 * from what was passed in if `defaultDayCapacity` had to be re-capped, so the UI
 * should render the return value rather than its own form state.
 */
export function writeSettings(partial: Partial<Settings>, db: Db = getDb()): Settings {
  const merged = validateSettings({ ...readSettings(db), ...partial });
  const serialized = serializeSettings(merged);

  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  const save = db.transaction((entries: Array<[string, string]>) => {
    for (const [key, value] of entries) upsert.run(key, value);
  });
  save(Object.entries(serialized));

  return merged;
}

/** Every value as the TEXT that goes on disk. Also used to seed the defaults. */
export function serializeSettings(settings: Settings): Record<keyof Settings, string> {
  return {
    period1Start: settings.period1Start,
    period1End: settings.period1End,
    period2Start: settings.period2Start,
    period2End: settings.period2End,
    period2Enabled: settings.period2Enabled ? 'true' : 'false',
    defaultDayCapacity: String(settings.defaultDayCapacity),
    visualMarginTop: String(settings.visualMarginTop),
    visualMarginBottom: String(settings.visualMarginBottom),
    planningHorizonWeeks: String(settings.planningHorizonWeeks),
    gapColor: settings.gapColor,
  };
}

// ---------------------------------------------------------------------------
// Parsing (the forgiving read path)
// ---------------------------------------------------------------------------

/**
 * Parses raw TEXT into `Settings`, applying each key's default when the value is
 * missing or unusable, then repairing combinations that cannot be true at once.
 * Pure — no database involved.
 */
export function normalizeSettings(raw: Partial<Record<keyof Settings, string>>): Settings {
  const parsed: Settings = {
    period1Start: parseTime(raw.period1Start, DEFAULT_SETTINGS.period1Start),
    period1End: parseTime(raw.period1End, DEFAULT_SETTINGS.period1End),
    period2Start: parseTime(raw.period2Start, DEFAULT_SETTINGS.period2Start),
    period2End: parseTime(raw.period2End, DEFAULT_SETTINGS.period2End),
    period2Enabled: parseBoolean(raw.period2Enabled, DEFAULT_SETTINGS.period2Enabled),
    defaultDayCapacity: parseNumber(raw.defaultDayCapacity, DEFAULT_SETTINGS.defaultDayCapacity),
    visualMarginTop: clamp(
      parseNumber(raw.visualMarginTop, DEFAULT_SETTINGS.visualMarginTop),
      MIN_MARGIN_HOURS,
      MAX_MARGIN_HOURS,
    ),
    visualMarginBottom: clamp(
      parseNumber(raw.visualMarginBottom, DEFAULT_SETTINGS.visualMarginBottom),
      MIN_MARGIN_HOURS,
      MAX_MARGIN_HOURS,
    ),
    planningHorizonWeeks: clamp(
      Math.round(parseNumber(raw.planningHorizonWeeks, DEFAULT_SETTINGS.planningHorizonWeeks)),
      MIN_HORIZON_WEEKS,
      MAX_HORIZON_WEEKS,
    ),
    gapColor: parseColor(raw.gapColor, DEFAULT_SETTINGS.gapColor),
  };

  // A morning that ends before it starts would make the shift negative: restore
  // both ends together, since either one of them could be the corrupt value.
  if (hhmmToMinutes(parsed.period1End) <= hhmmToMinutes(parsed.period1Start)) {
    parsed.period1Start = DEFAULT_SETTINGS.period1Start;
    parsed.period1End = DEFAULT_SETTINGS.period1End;
  }

  // Same for the afternoon, but only while it is switched on: a disabled period
  // keeps whatever times it had, ready for the day it is switched back on.
  if (parsed.period2Enabled && !isAfternoonConsistent(parsed)) {
    parsed.period2Start = DEFAULT_SETTINGS.period2Start;
    parsed.period2End = DEFAULT_SETTINGS.period2End;
    if (!isAfternoonConsistent(parsed)) {
      // The defaults do not fit behind an unusually long morning either.
      parsed.period2Enabled = false;
    }
  }

  parsed.defaultDayCapacity = capCapacity(parsed.defaultDayCapacity, parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// Validation (the strict write path)
// ---------------------------------------------------------------------------

/**
 * Checks a complete `Settings` and returns it with `defaultDayCapacity` re-capped.
 * Throws `SettingsValidationError` on anything else that is out of range.
 */
export function validateSettings(settings: Settings): Settings {
  const period1Start = requireTime(settings, 'period1Start');
  const period1End = requireTime(settings, 'period1End');
  const period2Start = requireTime(settings, 'period2Start');
  const period2End = requireTime(settings, 'period2End');

  if (period1End <= period1Start) {
    throw new SettingsValidationError('period1End', 'The morning must end after it starts');
  }

  if (settings.period2Enabled) {
    if (period2Start < period1End) {
      throw new SettingsValidationError('period2Start', 'The afternoon must start after the morning ends');
    }
    if (period2End <= period2Start) {
      throw new SettingsValidationError('period2End', 'The afternoon must end after it starts');
    }
  }

  requireNumberInRange(settings, 'visualMarginTop', MIN_MARGIN_HOURS, MAX_MARGIN_HOURS);
  requireNumberInRange(settings, 'visualMarginBottom', MIN_MARGIN_HOURS, MAX_MARGIN_HOURS);

  const horizon = requireNumberInRange(
    settings,
    'planningHorizonWeeks',
    MIN_HORIZON_WEEKS,
    MAX_HORIZON_WEEKS,
  );
  if (!Number.isInteger(horizon)) {
    throw new SettingsValidationError('planningHorizonWeeks', 'The planning horizon must be whole weeks');
  }

  if (!Number.isFinite(settings.defaultDayCapacity) || settings.defaultDayCapacity <= 0) {
    throw new SettingsValidationError('defaultDayCapacity', 'The daily capacity must be more than zero');
  }

  if (!HEX_COLOR_PATTERN.test(settings.gapColor)) {
    throw new SettingsValidationError('gapColor', 'The gap colour must be a #RRGGBB hex value');
  }

  return {
    ...settings,
    gapColor: settings.gapColor.toUpperCase(),
    defaultDayCapacity: capCapacity(settings.defaultDayCapacity, settings),
  };
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/** The working periods of a normal day, in chronological order. */
export function workPeriodsOf(settings: Settings): WorkPeriod[] {
  const periods: WorkPeriod[] = [
    { startMinutes: hhmmToMinutes(settings.period1Start), endMinutes: hhmmToMinutes(settings.period1End) },
  ];
  if (settings.period2Enabled) {
    periods.push({
      startMinutes: hhmmToMinutes(settings.period2Start),
      endMinutes: hhmmToMinutes(settings.period2End),
    });
  }
  return periods;
}

/**
 * The longest day the shift can cover, in hours — the ceiling for
 * `defaultDayCapacity`. Capacity exists to stop auto-fill early, never to book
 * hours the shift does not have.
 */
export function maxDayCapacityHours(settings: Settings): number {
  return minutesToHours(shiftMinutesOf(settings));
}

/** `Settings` converted into the minutes the engine and the calendar grid work in. */
export function dayShapeFromSettings(settings: Settings): DayShape {
  const periods = workPeriodsOf(settings);
  const marginTopMinutes = hoursToMinutes(settings.visualMarginTop);
  const marginBottomMinutes = hoursToMinutes(settings.visualMarginBottom);
  const firstStart = periods[0].startMinutes;
  const lastEnd = periods[periods.length - 1].endMinutes;

  return {
    periods,
    shiftMinutes: shiftMinutesOf(settings),
    capacityMinutes: hoursToMinutes(capCapacity(settings.defaultDayCapacity, settings)),
    marginTopMinutes,
    marginBottomMinutes,
    timelineStartMinutes: Math.max(0, firstStart - marginTopMinutes),
    timelineEndMinutes: Math.min(MINUTES_PER_DAY, lastEnd + marginBottomMinutes),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function shiftMinutesOf(settings: Settings): number {
  return workPeriodsOf(settings).reduce(
    (total, period) => total + (period.endMinutes - period.startMinutes),
    0,
  );
}

/**
 * Clamps capacity into `[min(1, shift), shift]` and rounds it to a whole minute,
 * so the value can never claim more hours than the periods cover.
 */
function capCapacity(hours: number, settings: Settings): number {
  const shiftHours = minutesToHours(shiftMinutesOf(settings));
  const floor = Math.min(1, shiftHours);
  const clamped = clamp(Number.isFinite(hours) ? hours : shiftHours, floor, shiftHours);
  return Math.round(clamped * MINUTES_PER_HOUR) / MINUTES_PER_HOUR;
}

function isAfternoonConsistent(settings: Settings): boolean {
  return (
    hhmmToMinutes(settings.period2Start) >= hhmmToMinutes(settings.period1End) &&
    hhmmToMinutes(settings.period2End) > hhmmToMinutes(settings.period2Start)
  );
}

function parseTime(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  try {
    hhmmToMinutes(value);
    return value;
  } catch {
    return fallback;
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseColor(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toUpperCase() : fallback;
}

function requireTime(settings: Settings, field: keyof Settings): number {
  const value = settings[field];
  if (typeof value !== 'string') {
    throw new SettingsValidationError(field, `${field} must be an HH:mm time`);
  }
  try {
    return hhmmToMinutes(value);
  } catch {
    throw new SettingsValidationError(field, `"${value}" is not an HH:mm time`);
  }
}

function requireNumberInRange(
  settings: Settings,
  field: keyof Settings,
  min: number,
  max: number,
): number {
  const value = settings[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new SettingsValidationError(field, `${field} must be between ${min} and ${max}`);
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
