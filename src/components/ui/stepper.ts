/**
 * Where a typed or nudged `NumberStepper` value lands. Kept out of the component so it can
 * be tested without a DOM.
 */

export interface StepperBounds {
  /** Grid the value snaps to. The shop plans in half hours. */
  step: number;
  min?: number;
  max?: number;
}

/**
 * `value` snapped to `step`, then held inside `[min, max]`. That order is load-bearing: a
 * bound off the step grid (`max 9.75, step 0.5`) is otherwise rounded back past itself.
 */
export function snapWithinBounds(value: number, { step, min, max }: StepperBounds): number {
  const grid = step > 0 ? step : 1;
  let result = Math.round(value / grid) * grid;
  if (min !== undefined && result < min) result = min;
  if (max !== undefined && result > max) result = max;
  return result;
}
