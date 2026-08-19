/**
 * What quarter hours `TimeSelect` offers. A list rather than a native `<input
 * type="time">`, measured on the Settings screen, which with
 * Chrome set to English drew "08:00 AM" beside a grid reading "08:00-14:00". Kept out of
 * the component so it can be tested without a DOM.
 */

import { MINUTES_PER_DAY, hhmmToMinutes } from '../../lib/dates';

/**
 * Quarter of an hour. Held equal to the drag layer's `SNAP_MINUTES` by
 * `timeOptions.test.ts`, so a typed time and a dragged one land on one grid.
 */
export const TIME_STEP_MINUTES = 15;

export interface TimeOptionsRange {
  /** Minutes between choices. Defaults to `TIME_STEP_MINUTES`. */
  stepMinutes?: number;
  /** Earliest choice, in minutes from midnight. Defaults to 00:00. */
  minMinutes?: number;
  /** Latest choice. Defaults to the last step before midnight (23:45). */
  maxMinutes?: number;
}

/**
 * `"08:00"` to 480, or `undefined` when the value is empty or not a time at all —
 * `hhmmToMinutes` throws, which is wrong for a control still being filled in.
 */
export function clockMinutes(value: string): number | undefined {
  try {
    return hhmmToMinutes(value);
  } catch {
    return undefined;
  }
}

/**
 * Every step inside the range, plus `current` when it does not sit on that grid.
 * `settings` is a hand-editable table, so a stored `08:10` is possible and dropping it
 * from the list would let opening a screen and saving move the start of the day.
 */
export function timeOptionMinutes(
  current: number | undefined,
  range: TimeOptionsRange = {},
): number[] {
  const step = Math.max(1, Math.round(range.stepMinutes ?? TIME_STEP_MINUTES));
  const from = clamp(Math.round(range.minMinutes ?? 0), 0, MINUTES_PER_DAY);
  const to = clamp(Math.round(range.maxMinutes ?? MINUTES_PER_DAY - step), 0, MINUTES_PER_DAY);

  const options: number[] = [];
  for (let minutes = from; minutes <= to; minutes += step) options.push(minutes);

  if (current !== undefined && Number.isFinite(current)) {
    const exact = Math.round(current);
    if (!options.includes(exact)) {
      options.push(exact);
      options.sort((a, b) => a - b);
    }
  }

  return options;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
