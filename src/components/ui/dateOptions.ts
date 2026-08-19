/**
 * Which days `DateSelect` offers and how they group into the calendar's own weeks.
 * Kept out of the component so it can be tested without a DOM.
 *
 * The window is a UI affordance, not a rule: a stored value outside it is always kept as
 * an option, and the forward reach is capped so a two-year horizon cannot become 700
 * options in one dropdown.
 */

import { addDays, compareDates, isValidDate, isoWeekNumber, startOfWeek } from '../../lib/dates';

const DAYS_PER_WEEK = 7;

/** How far back a date control reaches: a month is enough to correct what was done. */
export const PICKER_PAST_WEEKS = 4;

/** The forward reach when the caller does not know the horizon. Matches its default. */
export const PICKER_FUTURE_WEEKS = 8;

/** The forward reach a big horizon is capped to, so the list stays scannable. */
export const PICKER_MAX_FUTURE_WEEKS = 16;

/** A hard stop on the option count, whatever bounds a caller passes. */
const MAX_OPTION_DAYS = 400;

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

/**
 * Every day in the window, plus `current` when it falls outside it — a stored day the
 * list omits would be silently replaced the moment the form is saved.
 */
export function dayOptionDates(current: string | undefined, window: DayWindow): string[] {
  const days: string[] = [];

  if (isValidDate(window.minDate) && isValidDate(window.maxDate)) {
    let date = window.minDate;
    while (compareDates(date, window.maxDate) <= 0 && days.length < MAX_OPTION_DAYS) {
      days.push(date);
      date = addDays(date, 1);
    }
  }

  if (current !== undefined && isValidDate(current) && !days.includes(current)) {
    days.push(current);
    days.sort(compareDates);
  }

  return days;
}

/** One `<optgroup>`: the days of a single week, and the week they belong to. */
export interface DayOptionWeek {
  /** ISO week number, for the group's own label. */
  isoWeek: number;
  /** The week's Monday and Sunday — the range the calendar header shows. */
  startDate: string;
  endDate: string;
  dates: string[];
}

/**
 * The days split into the weeks the calendar already names, in order. A group is labelled
 * with the whole Monday-to-Sunday week even when only part of it is offered, so the label
 * cannot disagree with the week header's.
 */
export function groupDaysByWeek(dates: readonly string[]): DayOptionWeek[] {
  const weeks: DayOptionWeek[] = [];

  for (const date of dates) {
    const startDate = startOfWeek(date);
    const last = weeks[weeks.length - 1];
    if (last !== undefined && last.startDate === startDate) {
      last.dates.push(date);
      continue;
    }
    weeks.push({
      isoWeek: isoWeekNumber(date),
      startDate,
      endDate: addDays(startDate, DAYS_PER_WEEK - 1),
      dates: [date],
    });
  }

  return weeks;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
