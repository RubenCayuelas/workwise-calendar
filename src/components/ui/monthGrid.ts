/**
 * The 42 days a month's grid holds, and the marks each one carries without asking the server.
 * Kept out of the component so it can be tested without a DOM.
 *
 * Six rows always, even for a month that fits in four: the popover is then a constant height,
 * so clipping it against the viewport is arithmetic rather than a measurement.
 */

import {
  addDays,
  compareDates,
  isSameMonth,
  isValidDate,
  isWeekend,
  startOfMonth,
  startOfWeek,
} from '../../lib/dates';
import type { DayWindow } from './dateOptions';

const DAYS_PER_WEEK = 7;

export const MONTH_GRID_ROWS = 6;
export const MONTH_GRID_CELLS = MONTH_GRID_ROWS * DAYS_PER_WEEK;

export interface MonthCell {
  date: string;
  /** Belongs to the month being shown, rather than the neighbouring one that fills the row. */
  inMonth: boolean;
  /** Inside the window, or the stored value itself. */
  selectable: boolean;
  isToday: boolean;
  isWeekend: boolean;
  isPast: boolean;
}

export interface MonthGridOptions {
  /** The shop's today; a real date, since `isPast` is measured from it. */
  today: string;
  window: DayWindow;
  /** The stored value, offered however far outside the window it falls. */
  current?: string;
}

/** The six Monday-first weeks covering the month `month` falls in, whatever day of it it names. */
export function monthGrid(month: string, options: MonthGridOptions): MonthCell[] {
  const first = startOfMonth(month);
  const start = startOfWeek(first);
  // A caller's own bounds can arrive empty, and comparing against one would throw mid-render.
  const bounded = isValidDate(options.window.minDate) && isValidDate(options.window.maxDate);

  return Array.from({ length: MONTH_GRID_CELLS }, (_, index) => {
    const date = addDays(start, index);
    const inWindow =
      bounded &&
      compareDates(date, options.window.minDate) >= 0 &&
      compareDates(date, options.window.maxDate) <= 0;

    return {
      date,
      inMonth: isSameMonth(date, first),
      selectable: inWindow || date === options.current,
      isToday: date === options.today,
      isWeekend: isWeekend(date),
      isPast: compareDates(date, options.today) < 0,
    };
  });
}
