/**
 * The arithmetic behind `NumberStepper`: where a typed or nudged number lands.
 *
 * Kept out of the component so it can be tested without a DOM — the same reason
 * `timeOptions.ts` exists (see vitest.config.mts: the suite runs in Node).
 *
 * It is one short function because the ORDER of its two operations is a bug the app has
 * already had. Bounding first and snapping second lets a bound that is not itself a
 * multiple of the step be rounded back past itself, and the Settings capacity is exactly
 * that case: its max is the shift, which on quarter-hour periods can be 9.75 h. Focusing
 * the field and clicking away used to re-emit 9.75 as 10 — the capacity moving with no
 * owner input, which CLAUDE.md's *The Capacity Is Never Touched Alone* forbids.
 */

export interface StepperBounds {
  /** Grid the value snaps to. The shop plans in half hours. */
  step: number;
  min?: number;
  max?: number;
}

/**
 * `value` snapped to `step`, then held inside `[min, max]`.
 *
 * Snapping first keeps repeated `+step` from accumulating a float tail. Bounding second
 * means the result is always in range, even when a bound is off the step grid: a limit is
 * a legal value, and the grid never overrules it.
 */
export function snapWithinBounds(value: number, { step, min, max }: StepperBounds): number {
  const grid = step > 0 ? step : 1;
  let result = Math.round(value / grid) * grid;
  if (min !== undefined && result < min) result = min;
  if (max !== undefined && result > max) result = max;
  return result;
}
