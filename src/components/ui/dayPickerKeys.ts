/**
 * Where the keyboard moves the focused cell of the day picker's month grid: a key NAME in, a day
 * out. Structural rather than a `KeyboardEvent`, so the movement is testable with no DOM.
 */

import { addDays, addMonths, compareDates, startOfWeek } from '../../lib/dates';
import type { DayWindow } from './dateOptions';

const DAYS_PER_WEEK = 7;

export type DayPickerKey =
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown';

/** A full `Record`, so a key joining the union without a move of its own stops the build. */
const MOVES: Record<DayPickerKey, (date: string) => string> = {
  ArrowLeft: (date) => addDays(date, -1),
  ArrowRight: (date) => addDays(date, 1),
  ArrowUp: (date) => addDays(date, -DAYS_PER_WEEK),
  ArrowDown: (date) => addDays(date, DAYS_PER_WEEK),
  Home: (date) => startOfWeek(date),
  End: (date) => addDays(startOfWeek(date), DAYS_PER_WEEK - 1),
  PageUp: (date) => addMonths(date, -1),
  PageDown: (date) => addMonths(date, 1),
};

const KEYS: readonly string[] = Object.keys(MOVES);

export function isDayPickerKey(key: string): key is DayPickerKey {
  return KEYS.includes(key);
}

/**
 * The day the focus lands on, always inside `window`: a cell the window does not offer cannot be
 * chosen, so a move that would leave it stops on the edge instead. A stored day from outside the
 * window is a legal starting point, and the first press steps onto the nearest day inside.
 *
 * Caller obligation: a press can therefore answer with the day it was given, and the grid must read
 * the month off the day that came back rather than off the key that was pressed.
 */
export function moveFocusedDay(date: string, key: DayPickerKey, window: DayWindow): string {
  const moved = MOVES[key](date);
  if (compareDates(moved, window.minDate) < 0) return window.minDate;
  if (compareDates(moved, window.maxDate) > 0) return window.maxDate;
  return moved;
}
