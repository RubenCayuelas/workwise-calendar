/**
 * How far a date control reaches around today.
 *
 * The window is a UI affordance, not a rule: a stored value outside it is always kept, and the
 * forward reach is capped so a two-year horizon cannot become a calendar with no end.
 */

import { addDays, startOfWeek } from '../../lib/dates';

const DAYS_PER_WEEK = 7;

/** How far back a date control reaches: a month is enough to correct what was done. */
export const PICKER_PAST_WEEKS = 4;

/** The forward reach when the caller does not know the horizon. Matches its default. */
export const PICKER_FUTURE_WEEKS = 8;

/** Bounds how far the month picker's forward navigation can go. */
export const PICKER_MAX_FUTURE_WEEKS = 16;

/** An inclusive range of local `YYYY-MM-DD` days. */
export interface DayWindow {
  minDate: string;
  maxDate: string;
}

/** The days a form offers around `today`, in whole Monday-to-Sunday weeks. */
export function planningWindow(
  today: string,
  horizonWeeks: number = PICKER_FUTURE_WEEKS,
  pastWeeks: number = PICKER_PAST_WEEKS,
): DayWindow {
  const monday = startOfWeek(today);
  const forward = clamp(
    Number.isFinite(horizonWeeks) ? Math.trunc(horizonWeeks) : PICKER_FUTURE_WEEKS,
    1,
    PICKER_MAX_FUTURE_WEEKS,
  );
  const back = Math.max(0, Number.isFinite(pastWeeks) ? Math.trunc(pastWeeks) : 0);

  return {
    minDate: addDays(monday, -back * DAYS_PER_WEEK),
    // The Sunday that closes the last week of the horizon.
    maxDate: addDays(monday, forward * DAYS_PER_WEEK - 1),
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
