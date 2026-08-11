/**
 * The arithmetic behind `TimeSelect`: what quarter hours a time control offers, and
 * the one granularity the whole app agrees on.
 *
 * WHY A LIST INSTEAD OF `<input type="time">`: a native time input renders in the
 * BROWSER's locale, not the page's. On a shop PC with Chrome set to English it draws
 * "08:00 AM" while the grid next to it says "08:00–14:00", and the Settings screen hit
 * exactly that. Every time this app SHOWS goes through `useFormat().time()` so it is
 * spelled the same everywhere; a time the owner CHOOSES has to come from the same
 * spelling, so it is picked from a list.
 *
 * Kept out of the component so it can be tested without a DOM — the test suite runs in
 * Node (see vitest.config.mts).
 */

import { MINUTES_PER_DAY, hhmmToMinutes } from '../../lib/dates';

/**
 * Quarter of an hour.
 *
 * The SAME step the drag layer snaps a drop and a resize to (`SNAP_MINUTES` in
 * src/components/calendar/geometry.ts). A time typed into a form and a time dragged on
 * the grid have to land on one grid, or the two gestures disagree about what "16:15"
 * means and a hand-typed start can never be reached again by dragging.
 * `timeOptions.test.ts` holds the two constants equal.
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
 * `"08:00"` to 480, or `undefined` when the value is empty or not a time at all.
 *
 * The single safe parse in the UI: `hhmmToMinutes` throws on nonsense rather than
 * returning a silent zero, which is right for the engine and wrong for a control the
 * owner is still filling in.
 */
export function clockMinutes(value: string): number | undefined {
  try {
    return hhmmToMinutes(value);
  } catch {
    return undefined;
  }
}

/**
 * The choices a time control offers: every step inside the range, plus `current` when
 * it does not sit on that grid.
 *
 * That last part matters. `settings` is a hand-editable key/value table, so a stored
 * `08:10` is possible; dropping it from the list would make simply opening a screen and
 * saving anything quietly move the start of the workshop's day.
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
