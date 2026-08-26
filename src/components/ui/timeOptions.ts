/**
 * The quarter-hour grid every time in the app lands on, and the one safe parse behind every
 * screen that reads a clock time. A control of the app's own rather than a native `<input
 * type="time">`, measured on the Settings screen, which with Chrome set to English drew
 * "08:00 AM" beside a grid reading "08:00-14:00". Kept out of the component so it can be
 * tested without a DOM.
 */

import { hhmmToMinutes } from '../../lib/dates';

/**
 * Quarter of an hour. Held equal to the drag layer's `SNAP_MINUTES` by
 * `timeOptions.test.ts`, so a typed time and a dragged one land on one grid.
 */
export const TIME_STEP_MINUTES = 15;

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
