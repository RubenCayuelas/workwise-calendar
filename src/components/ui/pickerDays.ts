/**
 * The two marks a day cell cannot work out on its own — the grey of a closed day and the dot of one
 * the engine still has room in — and the span to ask the route for. Kept out of the component so it
 * can be tested without a DOM.
 */

import { endOfMonth, isSameMonth, isValidDate, startOfMonth } from '../../lib/dates';
import type { DayWindow } from './dateOptions';

/** What the route says about one day. The weekend and the past are derived in the client. */
export interface DayMark {
  isClosed: boolean;
  /** The day's stored note, which the cell says instead of the word "closed". */
  note?: string;
  hasRoom: boolean;
  /** Net working minutes still free. */
  freeMinutes: number;
}

/** The route's answer, by local `YYYY-MM-DD`. */
export type DayMarks = Readonly<Record<string, DayMark>>;

/**
 * A day the route did not send answers `undefined`, which an index lookup at the call site would
 * not: `noUncheckedIndexedAccess` is off, so `marks[date].isClosed` typechecks and then throws on
 * the first day outside the span.
 */
export function markOf(date: string, marks: DayMarks | undefined): DayMark | undefined {
  return marks?.[date];
}

/**
 * ONE request, covering the whole navigable window, widened to a whole month at either end the
 * stored value shares — the month the popover opens in when that value sits just outside.
 *
 * A value FURTHER out is deliberately left out. `window` is always `planningWindow`'s, so twenty
 * weeks at the most, and reaching a month a year away would ask for a span past
 * `MAX_DAY_MARK_DAYS`, which the route refuses whole: no marks anywhere rather than none in one
 * month.
 */
export function markRange(window: DayWindow, current?: string): { from: string; to: string } {
  if (current === undefined || !isValidDate(current)) {
    return { from: window.minDate, to: window.maxDate };
  }
  return {
    from: isSameMonth(current, window.minDate) ? startOfMonth(current) : window.minDate,
    to: isSameMonth(current, window.maxDate) ? endOfMonth(current) : window.maxDate,
  };
}
