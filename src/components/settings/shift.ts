/**
 * The shift arithmetic the Settings form needs while the owner is still typing, MIRRORING
 * src/lib/settings.ts because that module cannot be imported into a client component (better-sqlite3 at
 * module level). Nothing here decides whether a save is legal, or adjusts the capacity.
 *
 * KEEP IN SYNC: `MIN/MAX_MARGIN_HOURS`, `MIN/MAX_HORIZON_WEEKS`, `workPeriodsOf`,
 * `maxDayCapacityHours`, `dayShapeFromSettings` in src/lib/settings.ts.
 */

import { MINUTES_PER_DAY, hoursToMinutes, minutesToHours } from '../../lib/dates';
import { clockMinutes } from '../ui/timeOptions';
import type { Settings, WorkPeriod } from '../../types';

/** Visual margins: 0-2 hours each (src/lib/settings.ts MIN/MAX_MARGIN_HOURS). */
export const MARGIN_MIN_HOURS = 0;
export const MARGIN_MAX_HOURS = 2;

/** Planning horizon bounds (src/lib/settings.ts MIN/MAX_HORIZON_WEEKS). */
export const HORIZON_MIN_WEEKS = 1;
export const HORIZON_MAX_WEEKS = 104;

/** Half an hour: the smallest amount the shop plans in. */
export const HOUR_STEP = 0.5;

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

/**
 * Minutes from midnight, or `undefined` while the input holds something unusable. The parse itself lives
 * with the time control (`../ui/timeOptions`), which builds its option list from it — one safe parse for
 * the whole UI.
 */
export function timeMinutes(value: string): number | undefined {
  return clockMinutes(value);
}

export function isValidTime(value: string): boolean {
  return timeMinutes(value) !== undefined;
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
 * The working periods a draft would produce, in order. Unlike the server's `workPeriodsOf` this drops
 * what it cannot make sense of instead of throwing, so the preview and the capacity ceiling keep
 * working while a time is being retyped.
 */
export function periodsOf(settings: Settings): WorkPeriod[] {
  const periods: WorkPeriod[] = [];
  const morning = intervalOf(settings.period1Start, settings.period1End);
  if (morning !== undefined) periods.push(morning);

  if (settings.period2Enabled) {
    const afternoon = intervalOf(settings.period2Start, settings.period2End);
    // An afternoon starting before the morning ends is an invalid draft, not a second period.
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

/**
 * Capacity clamped into the draft's shift — FOR DRAWING ONLY. The stop line and the preview have to
 * point somewhere inside the day even while the draft holds a capacity the shift cannot buy, which it
 * now can. This never touches the draft.
 */
export function capCapacityHours(hours: number, settings: Settings): number {
  const shiftHours = maxCapacityHours(settings);
  // A draft with no usable period yet (a time mid-retype) must not zero the owner's number.
  if (shiftHours <= 0) return hours;
  const clamped = Math.min(Math.max(Number.isFinite(hours) ? hours : shiftHours, Math.min(1, shiftHours)), shiftHours);
  return Math.round(clamped * 60) / 60;
}

/**
 * Working minutes a day the stop line will not fill, because the capacity sits below the shift; 0 when
 * auto-fill runs to the end of the periods. Six hours of a ten hour shift is a legitimate choice and an
 * invisible one, so the Settings field and the header strip both state this number.
 */
export function capacitySlackMinutes(settings: Settings): number {
  const shiftMinutes = shiftMinutesOf(settings);
  if (shiftMinutes <= 0) return 0;
  return Math.max(0, shiftMinutes - hoursToMinutes(capCapacityHours(settings.defaultDayCapacity, settings)));
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
 * The clock time where auto-fill stops on an empty day — `defaultDayCapacity` made visible: with a 10 h
 * shift and an 8 h capacity, 17:30 rather than the end of the afternoon. `undefined` when the draft has
 * no usable period.
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

/**
 * Applies a field change to the draft. A plain merge, and that is the point: adjusting
 * `defaultDayCapacity` here is what left the shop at half a day for ever, so shortening the shift
 * leaves the capacity where the owner put it until they confirm the lower number on save —
 * `capacityReductionOf` is how the screen knows to ask.
 */
export function applySettingsPatch(draft: Settings, patch: Partial<Settings>): Settings {
  return { ...draft, ...patch };
}

/** The subset to PATCH: only what actually differs from what is stored. */
export function changedFields(saved: Settings, draft: Settings): Partial<Settings> {
  const patch: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    if (draft[key] !== saved[key]) patch[key] = draft[key];
  }
  return patch as Partial<Settings>;
}

export interface CapacityReduction {
  /** The capacity on screen — what the owner last chose. */
  fromHours: number;
  /** The most the draft's periods can buy: what saving would make it. */
  toHours: number;
  /** Hours a day auto-fill would stop planning. `fromHours - toHours`. */
  lostHours: number;
}

/**
 * The capacity this draft cannot afford, or `undefined` when it fits. Answered client-side because the
 * server would refuse the save and a refusal is not a choice — this is what keeps the exchange to one
 * round trip. `undefined` for a draft with no usable period, which cannot be saved anyway.
 */
export function capacityReductionOf(draft: Settings): CapacityReduction | undefined {
  const ceiling = maxCapacityHours(draft);
  if (ceiling <= 0 || draft.defaultDayCapacity <= ceiling) return undefined;
  return {
    fromHours: draft.defaultDayCapacity,
    toHours: ceiling,
    lostHours: draft.defaultDayCapacity - ceiling,
  };
}

/**
 * What the Save button would send: the changed fields, plus the lowered capacity when the draft's shift
 * can no longer buy the one on screen. The lowered capacity ONLY ever enters a patch here, which is what
 * makes "a cancelled confirmation sends nothing" true by construction.
 */
export function patchToSave(saved: Settings, draft: Settings): Partial<Settings> {
  const patch = changedFields(saved, draft);
  const reduction = capacityReductionOf(draft);
  return reduction === undefined ? patch : { ...patch, defaultDayCapacity: reduction.toHours };
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
  // Zero or nonsense is an issue; a capacity ABOVE the draft's shift deliberately is not — that draft
  // saves with the lower capacity the owner confirms, and flagging it would disable the Save button.
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
