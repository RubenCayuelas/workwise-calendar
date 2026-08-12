/**
 * The arithmetic behind `DateSelect`: which days a date control offers, and how they
 * are grouped into the weeks the calendar already names.
 *
 * WHY A LIST INSTEAD OF `<input type="date">`, for the same reason `timeOptions.ts`
 * exists: a native date input draws its parts in the BROWSER's locale, not the page's.
 * On a shop PC with Chrome set to English it writes `08/12/2026` for the 12th of
 * August, next to a grid that says "Mié 12 ago" — and `03/08` is genuinely ambiguous.
 * Every day this app SHOWS goes through `useFormat()`, so a day the owner CHOOSES has
 * to be spelled by the same helpers.
 *
 * THE WINDOW IS A UI AFFORDANCE, NOT A RULE. The owner is always choosing a day in the
 * schedule, so the list runs from a few weeks back (the past stays editable by hand —
 * that is how yesterday gets corrected) to the end of the planning horizon. Two things
 * keep that from taking anything away:
 *
 * - the value already stored is ALWAYS an option, even when it falls outside, so
 *   editing an old gap never silently moves it;
 * - a horizon can be set to two years (`MAX_HORIZON_WEEKS`), which would be 700+
 *   options in one dropdown, so the forward reach is capped at
 *   `PICKER_MAX_FUTURE_WEEKS`. Anything further out is reached by dragging on the
 *   calendar itself, which is where a date that far away is chosen anyway.
 *
 * Kept out of the component so it can be tested without a DOM — the suite runs in Node.
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

/**
 * The days a form offers around `today`: whole weeks, so every group in the list is a
 * complete Monday-to-Sunday week the header would recognise.
 */
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
 * Every day in the window, plus `current` when it falls outside it.
 *
 * That last part is the same promise `timeOptionMinutes` makes: a stored value the
 * list does not contain would be replaced by whatever the list starts with the moment
 * the form is saved, which for a gap recorded last quarter would move it silently.
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
 * The days split into the weeks the calendar already names, in order.
 *
 * The group is labelled with the WHOLE week (Monday to Sunday) even when only part of
 * it is offered, because that label is the one the week header uses and the two must
 * not disagree about what "Semana 33" spans.
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
