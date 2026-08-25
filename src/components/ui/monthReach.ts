/**
 * Which month the day picker opens on, and how far its two arrows reach. Kept out of the
 * component so it can be tested without a DOM.
 */

import { addMonths, compareDates, isValidDate, startOfMonth } from '../../lib/dates';
import type { DayWindow } from './dateOptions';

/** Whether each arrow still has a month to reach in its own direction. */
export interface MonthReach {
  canPrevious: boolean;
  canNext: boolean;
}

/**
 * The month whose grid opens, as its 1st. A stored day outside the window opens on ITS month
 * and is never pulled inside: the window is an affordance and the stored day is the datum.
 * `options.today` is the shop's own day, so it is a real date; `current` need not be.
 */
export function openingMonth(
  current: string,
  options: { today: string; window: DayWindow },
): string {
  if (isValidDate(current)) return startOfMonth(current);
  return clampToWindow(startOfMonth(options.today), options.window);
}

export function monthReach(month: string, window: DayWindow): MonthReach {
  // A caller's own bounds can arrive empty, and comparing against one would throw mid-render.
  if (!isValidDate(window.minDate) || !isValidDate(window.maxDate)) {
    return { canPrevious: false, canNext: false };
  }
  const first = startOfMonth(month);
  return {
    canPrevious: compareDates(first, startOfMonth(window.minDate)) > 0,
    canNext: compareDates(first, startOfMonth(window.maxDate)) < 0,
  };
}

/**
 * One month along, and never out of the window. From a month outside it — the one a stored day
 * opened on — this lands on the nearest month the window offers rather than on the next empty
 * one, so a live arrow always changes what can be chosen.
 */
export function stepMonth(month: string, direction: 1 | -1, window: DayWindow): string {
  const first = startOfMonth(month);
  const reach = monthReach(first, window);
  if (direction === 1 ? !reach.canNext : !reach.canPrevious) return first;
  return clampToWindow(addMonths(first, direction), window);
}

function clampToWindow(month: string, window: DayWindow): string {
  if (!isValidDate(window.minDate) || !isValidDate(window.maxDate)) return month;
  const first = startOfMonth(window.minDate);
  const last = startOfMonth(window.maxDate);
  if (compareDates(month, first) < 0) return first;
  if (compareDates(month, last) > 0) return last;
  return month;
}
