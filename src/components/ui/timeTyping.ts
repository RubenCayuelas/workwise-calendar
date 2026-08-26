/**
 * What a typed time means: how a short form is read, where an arrow lands, and what leaving the field
 * stores. Kept out of the component so it can be tested without a DOM.
 */

import { MINUTES_PER_DAY, MINUTES_PER_HOUR, minutesToHHmm } from '../../lib/dates';
import { snapWithinBounds } from './stepper';
import { TIME_STEP_MINUTES, clockMinutes } from './timeOptions';

/** The last quarter of the day: the highest value an arrow or a commit will produce. */
export const MAX_TYPED_MINUTES = MINUTES_PER_DAY - TIME_STEP_MINUTES;

/** Minutes from midnight, both ends inclusive. */
export interface TimeBounds {
  minMinutes?: number;
  maxMinutes?: number;
}

export type TimeCommit =
  | { ok: true; value: string }
  | { ok: false; reason: 'invalid-format' }
  | { ok: false; reason: 'out-of-bounds'; minMinutes: number; maxMinutes: number };

const DIGITS_ONLY = /^\d{1,4}$/;
const HOURS_AND_MINUTES = /^(\d{1,2}):(\d{2})$/;

/** `'8'` -> `'08:00'`, `'830'` -> `'08:30'`, `'0830'` -> `'08:30'`, `'8:30'` -> `'08:30'`. */
export function normalizeTypedTime(value: string): string | undefined {
  const typed = value.trim();
  const spelled = DIGITS_ONLY.test(typed) ? spellDigits(typed) : typed;
  if (!HOURS_AND_MINUTES.test(spelled)) return undefined;

  const minutes = clockMinutes(spelled);
  // `hhmmToMinutes` reads "24:00" as 1440, and a start that big leaves the grid drawing no band at
  // all while the field still looks legal.
  if (minutes === undefined || minutes >= MINUTES_PER_DAY) return undefined;
  return minutesToHHmm(minutes);
}

export function stepTypedTime(
  value: string,
  direction: 1 | -1,
  options: { wholeHour?: boolean; bounds?: TimeBounds } = {},
): string {
  const current = typedMinutes(value);
  if (current === undefined) return value;

  const grid = options.wholeHour === true ? MINUTES_PER_HOUR : TIME_STEP_MINUTES;
  // Off the grid the first press lands on the next multiple in that direction: rounding to the
  // nearest would send a press of `+` on 08:20 backwards to 08:15.
  const aligned =
    direction > 0 ? Math.ceil(current / grid) * grid : Math.floor(current / grid) * grid;
  const next = aligned === current ? current + direction * grid : aligned;

  const { minMinutes, maxMinutes } = effectiveBounds(options.bounds);
  return minutesToHHmm(snapWithinBounds(next, { step: grid, min: minMinutes, max: maxMinutes }));
}

export function commitTypedTime(
  valueAtFocus: string,
  value: string,
  bounds?: TimeBounds,
): TimeCommit {
  const minutes = typedMinutes(value);
  if (minutes === undefined) return { ok: false, reason: 'invalid-format' };

  // Only what was actually retyped is snapped: `changedFields` compares the strings, so rounding a
  // stored 08:10 on the way past would send it in a Settings patch that empties the undo line.
  if (value === valueAtFocus) return { ok: true, value };

  const { minMinutes, maxMinutes } = effectiveBounds(bounds);
  if (minutes < minMinutes || minutes > maxMinutes) {
    return { ok: false, reason: 'out-of-bounds', minMinutes, maxMinutes };
  }
  // Bounds read as typed, then the snap held inside them. A ceiling one step before the shift
  // closes is off the quarter grid (17:55 on a 14:10-18:10 afternoon): snapping first would round
  // that ceiling past itself and the field would refuse the very moment its own error names.
  return {
    ok: true,
    value: minutesToHHmm(
      snapWithinBounds(minutes, { step: TIME_STEP_MINUTES, min: minMinutes, max: maxMinutes }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** A bare number as a clock time: one or two digits are the hour, three or four hour and minutes. */
function spellDigits(digits: string): string {
  if (digits.length <= 2) return `${digits}:00`;
  return `${digits.slice(0, digits.length - 2)}:${digits.slice(-2)}`;
}

/** Minutes from midnight for a value as typed, `undefined` when it is not one time. */
function typedMinutes(value: string): number | undefined {
  const normalized = normalizeTypedTime(value);
  return normalized === undefined ? undefined : clockMinutes(normalized);
}

/** The caller's bounds, held inside 00:00-23:45 and in order. */
function effectiveBounds(bounds: TimeBounds = {}): { minMinutes: number; maxMinutes: number } {
  const minMinutes = boundMinutes(bounds.minMinutes, 0);
  const maxMinutes = boundMinutes(bounds.maxMinutes, MAX_TYPED_MINUTES);
  return { minMinutes, maxMinutes: Math.max(minMinutes, maxMinutes) };
}

function boundMinutes(value: number | undefined, fallback: number): number {
  const minutes = value === undefined || !Number.isFinite(value) ? fallback : Math.round(value);
  return Math.min(MAX_TYPED_MINUTES, Math.max(0, minutes));
}
