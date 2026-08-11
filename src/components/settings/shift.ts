/**
 * The shift arithmetic the Settings form needs while the owner is still typing.
 *
 * WHY THIS MIRRORS src/lib/settings.ts INSTEAD OF IMPORTING IT: that module imports
 * src/lib/db.ts (better-sqlite3) at module level, so it cannot be pulled into a client
 * component. And the form genuinely needs the arithmetic client-side, on the DRAFT: the
 * auto-fill capacity's ceiling is the sum of the enabled periods, so it has to follow
 * the period times as they are edited, before anything is saved.
 *
 * The server remains the authority. Every value goes through `validateSettings()` on
 * save, which rejects out-of-range input with the offending `field` attached, and
 * re-caps `defaultDayCapacity` rather than rejecting it. Nothing here decides whether a
 * save is legal — it only keeps the form from proposing an impossible one.
 *
 * KEEP IN SYNC with src/lib/settings.ts: `MIN/MAX_MARGIN_HOURS`, `MIN/MAX_HORIZON_WEEKS`,
 * `workPeriodsOf`, `capCapacity`, `dayShapeFromSettings`.
 */

import { MINUTES_PER_DAY, hhmmToMinutes, hoursToMinutes, minutesToHours } from '../../lib/dates';
import type { Settings, WorkPeriod } from '../../types';

/** Visual margins: 0-2 hours each (src/lib/settings.ts MIN/MAX_MARGIN_HOURS). */
export const MARGIN_MIN_HOURS = 0;
export const MARGIN_MAX_HOURS = 2;

/** Planning horizon bounds (src/lib/settings.ts MIN/MAX_HORIZON_WEEKS). */
export const HORIZON_MIN_WEEKS = 1;
export const HORIZON_MAX_WEEKS = 104;

/** Half an hour: the smallest amount the shop plans in. */
export const HOUR_STEP = 0.5;

/** The grid the period times are chosen on: every quarter of an hour. */
export const TIME_OPTION_STEP_MINUTES = 15;

/** Every key of `Settings`, in the order the form shows them. */
export const SETTINGS_KEYS: readonly (keyof Settings)[] = [
  'period1Start',
  'period1End',
  'period2Start',
  'period2End',
  'period2Enabled',
  'defaultDayCapacity',
  'visualMarginTop',
  'visualMarginBottom',
  'planningHorizonWeeks',
  'gapColor',
];

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

/** Minutes from midnight, or `undefined` while the input holds something unusable. */
export function timeMinutes(value: string): number | undefined {
  try {
    return hhmmToMinutes(value);
  } catch {
    // A cleared `<input type="time">` reports "", and a half-typed value is normal
    // mid-keystroke. Neither is an error to shout about — it just cannot be derived from.
    return undefined;
  }
}

export function isValidTime(value: string): boolean {
  return timeMinutes(value) !== undefined;
}

/**
 * The choices a period-time control offers: every quarter hour of the day, plus the
 * current value when it does not sit on that grid.
 *
 * That last part matters. `settings` is a hand-editable key/value table, so a stored
 * `08:10` is possible; dropping it from the list would make simply opening the Settings
 * screen and saving anything quietly move the start of the workshop's day.
 */
export function timeOptionMinutes(current: string): number[] {
  const options: number[] = [];
  for (let minutes = 0; minutes < MINUTES_PER_DAY; minutes += TIME_OPTION_STEP_MINUTES) {
    options.push(minutes);
  }

  const exact = timeMinutes(current);
  if (exact !== undefined && !options.includes(exact)) {
    options.push(exact);
    options.sort((a, b) => a - b);
  }

  return options;
}

export function isValidColor(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value);
}

/** A period, or `undefined` when either end is unusable or the order is wrong. */
function intervalOf(start: string, end: string): WorkPeriod | undefined {
  const startMinutes = timeMinutes(start);
  const endMinutes = timeMinutes(end);
  if (startMinutes === undefined || endMinutes === undefined) return undefined;
  return endMinutes > startMinutes ? { startMinutes, endMinutes } : undefined;
}

// ---------------------------------------------------------------------------
// Derived views of a draft
// ---------------------------------------------------------------------------

/**
 * The working periods a draft would produce, in order. Unlike the server's
 * `workPeriodsOf`, this one drops what it cannot make sense of instead of throwing, so
 * the preview and the capacity ceiling keep working while a time is being retyped.
 */
export function periodsOf(settings: Settings): WorkPeriod[] {
  const periods: WorkPeriod[] = [];
  const morning = intervalOf(settings.period1Start, settings.period1End);
  if (morning !== undefined) periods.push(morning);

  if (settings.period2Enabled) {
    const afternoon = intervalOf(settings.period2Start, settings.period2End);
    // An afternoon that would start before the morning ends is not a second period,
    // it is an invalid draft: leave it out rather than drawing overlapping bands.
    if (afternoon !== undefined && (morning === undefined || afternoon.startMinutes >= morning.endMinutes)) {
      periods.push(afternoon);
    }
  }

  return periods;
}

/** The lunch break: the space between two periods. Never stored as a gap. */
export function lunchOf(settings: Settings): WorkPeriod | undefined {
  const periods = periodsOf(settings);
  if (periods.length < 2) return undefined;
  const [first, second] = periods;
  return second.startMinutes > first.endMinutes
    ? { startMinutes: first.endMinutes, endMinutes: second.startMinutes }
    : undefined;
}

/** Total working minutes the enabled periods cover — the ceiling for capacity. */
export function shiftMinutesOf(settings: Settings): number {
  return periodsOf(settings).reduce(
    (total, period) => total + (period.endMinutes - period.startMinutes),
    0,
  );
}

/** The maximum `defaultDayCapacity` the current draft allows, in hours. */
export function maxCapacityHours(settings: Settings): number {
  return minutesToHours(shiftMinutesOf(settings));
}

/** The floor, matching the server's `Math.min(1, shiftHours)`. */
export function minCapacityHours(settings: Settings): number {
  return Math.min(1, maxCapacityHours(settings));
}

/** Capacity clamped into the draft's shift, as `capCapacity` does on the server. */
export function capCapacityHours(hours: number, settings: Settings): number {
  const shiftHours = maxCapacityHours(settings);
  // A draft with no usable period yet (a time mid-retype) must not silently zero the
  // number the owner typed. Leave it alone; the shift will come back.
  if (shiftHours <= 0) return hours;
  const clamped = Math.min(Math.max(Number.isFinite(hours) ? hours : shiftHours, Math.min(1, shiftHours)), shiftHours);
  return Math.round(clamped * 60) / 60;
}

/** Top and bottom of the time axis the calendar would draw, margins included. */
export function timelineOf(settings: Settings): WorkPeriod | undefined {
  const periods = periodsOf(settings);
  if (periods.length === 0) return undefined;
  return {
    startMinutes: Math.max(0, periods[0].startMinutes - hoursToMinutes(settings.visualMarginTop)),
    endMinutes: Math.min(
      MINUTES_PER_DAY,
      periods[periods.length - 1].endMinutes + hoursToMinutes(settings.visualMarginBottom),
    ),
  };
}

/**
 * The clock time where auto-fill stops on an empty day.
 *
 * This is the whole point of `defaultDayCapacity` made visible: with 10 h of shift and
 * a capacity of 8 h, the engine fills the morning and then stops at 17:30 instead of
 * running to the end of the afternoon. `undefined` when the draft has no usable period.
 */
export function autoFillStopMinutes(settings: Settings): number | undefined {
  const periods = periodsOf(settings);
  if (periods.length === 0) return undefined;

  let remaining = hoursToMinutes(capCapacityHours(settings.defaultDayCapacity, settings));
  for (const period of periods) {
    const length = period.endMinutes - period.startMinutes;
    if (remaining <= length) return period.startMinutes + remaining;
    remaining -= length;
  }
  return periods[periods.length - 1].endMinutes;
}

// ---------------------------------------------------------------------------
// Editing a draft
// ---------------------------------------------------------------------------

export interface DraftPatchResult {
  settings: Settings;
  /**
   * Set when the patch pulled `defaultDayCapacity` down by itself — a shorter shift or
   * the afternoon switched off. CLAUDE.md re-caps rather than rejecting, so the form has
   * to say it out loud or the number changes under the owner's eyes with no explanation.
   */
  recappedToHours?: number;
}

/**
 * Applies a field change to the draft and re-caps the capacity in the same step, so the
 * ceiling can never lag a period edit by a render.
 */
export function applySettingsPatch(draft: Settings, patch: Partial<Settings>): DraftPatchResult {
  const merged: Settings = { ...draft, ...patch };
  const capped = capCapacityHours(merged.defaultDayCapacity, merged);
  const editedCapacityDirectly = patch.defaultDayCapacity !== undefined;

  return {
    settings: { ...merged, defaultDayCapacity: capped },
    // Editing the capacity field itself already shows its own max; only an indirect
    // re-cap needs announcing.
    recappedToHours:
      !editedCapacityDirectly && capped !== merged.defaultDayCapacity ? capped : undefined,
  };
}

/** The subset to PATCH: only what actually differs from what is stored. */
export function changedFields(saved: Settings, draft: Settings): Partial<Settings> {
  const patch: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    if (draft[key] !== saved[key]) patch[key] = draft[key];
  }
  return patch as Partial<Settings>;
}

// ---------------------------------------------------------------------------
// Local validation
// ---------------------------------------------------------------------------

/**
 * Why a draft cannot be saved. The codes mirror `validateSettings`'s refusals so the
 * form can refuse first instead of round-tripping a 400 the owner would have to read.
 */
export type SettingsIssue =
  | 'time'
  | 'morningOrder'
  | 'afternoonStart'
  | 'afternoonOrder'
  | 'range'
  | 'color';

export type SettingsIssues = Partial<Record<keyof Settings, SettingsIssue>>;

export function draftIssues(draft: Settings): SettingsIssues {
  const issues: SettingsIssues = {};

  const morningStart = timeMinutes(draft.period1Start);
  const morningEnd = timeMinutes(draft.period1End);
  if (morningStart === undefined) issues.period1Start = 'time';
  if (morningEnd === undefined) issues.period1End = 'time';
  if (morningStart !== undefined && morningEnd !== undefined && morningEnd <= morningStart) {
    issues.period1End = 'morningOrder';
  }

  if (draft.period2Enabled) {
    const afternoonStart = timeMinutes(draft.period2Start);
    const afternoonEnd = timeMinutes(draft.period2End);
    if (afternoonStart === undefined) issues.period2Start = 'time';
    if (afternoonEnd === undefined) issues.period2End = 'time';
    if (afternoonStart !== undefined && morningEnd !== undefined && afternoonStart < morningEnd) {
      issues.period2Start = 'afternoonStart';
    }
    if (afternoonStart !== undefined && afternoonEnd !== undefined && afternoonEnd <= afternoonStart) {
      issues.period2End = 'afternoonOrder';
    }
  }

  if (!isInRange(draft.visualMarginTop, MARGIN_MIN_HOURS, MARGIN_MAX_HOURS)) {
    issues.visualMarginTop = 'range';
  }
  if (!isInRange(draft.visualMarginBottom, MARGIN_MIN_HOURS, MARGIN_MAX_HOURS)) {
    issues.visualMarginBottom = 'range';
  }
  if (
    !isInRange(draft.planningHorizonWeeks, HORIZON_MIN_WEEKS, HORIZON_MAX_WEEKS) ||
    !Number.isInteger(draft.planningHorizonWeeks)
  ) {
    issues.planningHorizonWeeks = 'range';
  }
  if (!Number.isFinite(draft.defaultDayCapacity) || draft.defaultDayCapacity <= 0) {
    issues.defaultDayCapacity = 'range';
  }
  if (!isValidColor(draft.gapColor)) issues.gapColor = 'color';

  return issues;
}

export function hasIssues(issues: SettingsIssues): boolean {
  return Object.keys(issues).length > 0;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isInRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}
