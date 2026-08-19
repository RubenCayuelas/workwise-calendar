/**
 * The typed settings repository — the only module that knows the `settings` table is key/value TEXT.
 * The READ path repairs (a hand-edited row must not take the calendar down); the WRITE path refuses,
 * naming the field. Invariant: what `writeSettings` returns is what the next `readSettings` returns.
 */

import { getDb, type Db } from './db';
import { manualWindowsOf } from './manualWindow';
import {
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  hhmmToMinutes,
  hoursToMinutes,
  minutesToHours,
} from './dates';
import type { DayShape, Settings, SettingsRow, WorkPeriod } from '../types';

/** The split shift the workshop runs. `gapColor` matches `--ww-gap-fill` in workwise-tokens.css. */
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
 * Merges `partial` over the stored configuration, validates it and saves it in one transaction.
 * Nothing is adjusted on the way through — `gapColor` is upper-cased and that is all — so what comes
 * back is what is on disk: a capacity the shift cannot buy is an error, not a quiet correction.
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

/** Every value as the TEXT that goes on disk; also used to seed the defaults. */
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
 * Raw TEXT into `Settings`: each key's default where the value is unusable, then combinations that
 * cannot be true at once repaired. Pure — no database involved.
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

  // The one place the capacity is pulled down unasked: a stored row can hold a value the shift
  // cannot buy, and every derived number downstream assumes it cannot. A WRITE refuses instead.
  parsed.defaultDayCapacity = clampCapacityToShift(parsed.defaultDayCapacity, parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// Validation (the strict write path)
// ---------------------------------------------------------------------------

/**
 * Checks a complete `Settings` and returns it unchanged but for an upper-cased `gapColor`. Throws
 * `SettingsValidationError` naming the field — including a `defaultDayCapacity` above the hours the
 * enabled periods cover, which a caller shortening the shift must lower in the SAME patch.
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

  const capacity = settings.defaultDayCapacity;
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new SettingsValidationError('defaultDayCapacity', 'The daily capacity must be more than zero');
  }

  const shiftHours = maxDayCapacityHours(settings);
  if (capacity > shiftHours) {
    throw new SettingsValidationError(
      'defaultDayCapacity',
      `The daily capacity of ${capacity} h is more than the ${shiftHours} h the enabled periods cover: send the capacity you want with the change`,
    );
  }

  // The floor and the granularity are refused for the same reason the ceiling is: they are the
  // other two ways the read path's repair could quietly change this number after it was accepted.
  const floorHours = capacityFloorHours(shiftHours);
  if (capacity < floorHours) {
    throw new SettingsValidationError(
      'defaultDayCapacity',
      `The daily capacity of ${capacity} h is less than the ${floorHours} h minimum`,
    );
  }
  if (!isWholeMinutes(capacity)) {
    throw new SettingsValidationError(
      'defaultDayCapacity',
      `The daily capacity of ${capacity} h is not a whole number of minutes`,
    );
  }

  if (!HEX_COLOR_PATTERN.test(settings.gapColor)) {
    throw new SettingsValidationError('gapColor', 'The gap colour must be a #RRGGBB hex value');
  }

  return { ...settings, gapColor: settings.gapColor.toUpperCase() };
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
 * The longest day the shift can cover, in hours — the ceiling `defaultDayCapacity` may not exceed,
 * and the number both the refusal and the Settings screen's question name.
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
    // Derived here so `periods` and `manualWindows` can never disagree — see ./manualWindow.ts.
    manualWindows: manualWindowsOf(periods, marginTopMinutes, marginBottomMinutes),
    shiftMinutes: shiftMinutesOf(settings),
    // Clamped for the same reason the read path clamps: a `Settings` assembled by hand could claim
    // more than the shift. Anything from `readSettings` or `writeSettings` already fits.
    capacityMinutes: hoursToMinutes(clampCapacityToShift(settings.defaultDayCapacity, settings)),
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
 * Clamps capacity into `[min(1, shift), shift]` and rounds it to a whole minute. A REPAIR, not a
 * rule: only the read path and the derived `DayShape` use it, so a hand-written value cannot make
 * `capacityMinutes` claim hours the periods lack. The write path refuses every value this would move.
 */
function clampCapacityToShift(hours: number, settings: Settings): number {
  const shiftHours = minutesToHours(shiftMinutesOf(settings));
  const clamped = clamp(
    Number.isFinite(hours) ? hours : shiftHours,
    capacityFloorHours(shiftHours),
    shiftHours,
  );
  return Math.round(clamped * MINUTES_PER_HOUR) / MINUTES_PER_HOUR;
}

/**
 * The least the capacity may be: an hour, or the whole shift when that is shorter. Below this is not
 * "finish early", it is a day that plans nothing.
 */
function capacityFloorHours(shiftHours: number): number {
  return Math.min(1, shiftHours);
}

/**
 * Whether an amount of hours lands on a whole minute — the unit everything downstream works in
 * (`hoursToMinutes` rounds, so 5.7777 h silently becomes 347 min). Tolerant on purpose: the form
 * offers the shift itself, and a 593-minute shift is `593 / 60`, whose double times 60 is 592.999….
 */
function isWholeMinutes(hours: number): boolean {
  const minutes = hours * MINUTES_PER_HOUR;
  return Math.abs(minutes - Math.round(minutes)) < 1e-6;
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
