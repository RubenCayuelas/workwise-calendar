/**
 * The two things the small forms (split, gap) both need.
 *
 * Kept out of the components so a `<input type="time">` is parsed in exactly one place:
 * the engine speaks integer minutes from midnight, the control speaks `HH:mm`, and the
 * conversion belongs to `src/lib/dates.ts`, which throws on nonsense rather than
 * returning a silent zero.
 */

import { hhmmToMinutes } from '../../lib/dates';

/** Half an hour: the granularity the shop plans in, and `NumberStepper`'s default. */
export const HOUR_STEP = 0.5;

/**
 * `"08:00"` to 480, or `undefined` when the control is empty or half-typed.
 *
 * A native time input can hold `""` while the owner is still typing, which is not an
 * error to shout about — it is just not submittable yet.
 */
export function parseClockTime(value: string): number | undefined {
  try {
    return hhmmToMinutes(value);
  } catch {
    return undefined;
  }
}
