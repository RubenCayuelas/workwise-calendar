/**
 * Turning the engine's numbers into what the owner reads.
 *
 * Pure, client-safe and free of react-i18next: every function takes the language as
 * an argument. The React-flavoured version is `useFormat()` in src/lib/useFormat.ts,
 * which binds the current language and the `t` function once so a component just
 * calls `format.dayHeader(date)`.
 *
 * Two rules this file exists to enforce, so three screens cannot disagree:
 *
 * - Minutes in, string out. The domain carries INTEGER MINUTES everywhere; hours are
 *   a presentation detail and `2.5` must render as "2,5" in Spanish and "2.5" in
 *   English. Never build an hour label with string concatenation or `toFixed`.
 * - A date is a local `YYYY-MM-DD`, never an instant. `localDateOf` builds the `Date`
 *   that `Intl` needs at LOCAL midnight, from the string's own parts, so nothing here
 *   can shift a day across a timezone the way `new Date("2026-08-13")` (which parses
 *   as UTC) would.
 */

import { MINUTES_PER_DAY, minutesToHHmm, minutesToHours, parseDate, weekdayOf } from './dates';
import { intlLocaleOf } from './i18n';

/** A translate function, structurally — so this module never imports i18next. */
export type TranslateFn = (key: string, values?: Record<string, unknown>) => string;

/**
 * The `Date` an `Intl` formatter needs for a local calendar day.
 *
 * Built from the parts at LOCAL midday rather than midnight: midday is far enough
 * from either boundary that no DST transition (which happens at 02:00/03:00 local)
 * can push the value onto the neighbouring day.
 */
export function localDateOf(date: string): Date {
  const { year, month, day } = parseDate(date);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// Hours and times
// ---------------------------------------------------------------------------

/**
 * Minutes as the NUMBER part of an hours label: 360 -> "6", 150 -> "2,5" (es).
 *
 * The " h" lives in the locale files (`units.hours`), because where the unit goes is
 * a language decision. Use `useFormat().hours()` for the whole label.
 */
export function formatHourNumber(minutes: number, language: string): string {
  return new Intl.NumberFormat(intlLocaleOf(language), {
    maximumFractionDigits: 2,
  }).format(minutesToHours(minutes));
}

/** A plain decimal-hours number, for a form input's value. Locale-independent. */
export function hourInputValue(minutes: number): number {
  return minutesToHours(minutes);
}

/**
 * What a time outside the calendar day renders as. Deliberately a shape no real time
 * has, so it reads as "this row is wrong" rather than as a plausible hour.
 */
export const INVALID_TIME = '--:--';

/**
 * Minutes from midnight as a 24 h clock time: 480 -> "08:00".
 *
 * FAILS SOFT, and only here. `minutesToHHmm` throws on a value outside the day, which is
 * right for the engine and for every write — but on the RENDER path that throw took the
 * whole week view down (`Invalid minutes "1500"`, out of `useFormat().time`) and left the
 * owner an "Application error" with no way back to the calendar. The row it could not
 * draw was the very row they needed to reach in order to fix it.
 *
 * THERE ARE TWO WAYS TO GET HERE AND THIS FUNCTION CANNOT TELL THEM APART, which is why
 * the complaint no longer picks one:
 *
 *  - A ROW STORED OUT OF RANGE. `assertRowInsideDay` makes that unstorable now, but a
 *    database written BEFORE the guard existed still holds one, and a shop PC's
 *    `data/calendar.db` is not something a fix can retroactively repair. The app has to be
 *    able to display the mistake in order to let the owner correct it.
 *  - A VALUE THAT WAS NEVER A TIME OF DAY. `duration` is NET WORKING MINUTES, so
 *    `start + duration` is only a clock reading when those minutes all fit inside the day
 *    from that start. The drag ghost added a whole RUN's minutes — 18 h across two days —
 *    to a 07:00 start and formatted 1500 as an end-of-day, once per pointer move. The old
 *    wording, "a stored row is out of range", sent that investigation to the database, and
 *    the database was clean the whole time.
 *
 * It does not hide a real bug, which was the argument for leaving it throwing:
 *  - `minutesToHHmm` is untouched, so the engine, the repositories, the API and every
 *    test still throw on such a value — the loud path stays loud where it can act;
 *  - the placeholder is VISIBLE on screen, which is louder than a clamp that would have
 *    quietly drawn 25:00 as 01:00;
 *  - and it complains to the console with the offending value and both suspects.
 */
export function formatTime(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > MINUTES_PER_DAY) {
    console.error(
      `formatTime: ${minutes} is not a minute of the day (0-${MINUTES_PER_DAY}). ` +
        'Either a row is stored out of range, or a DURATION was added to a start and the ' +
        'sum formatted as a clock time — net working minutes are not a time of day.',
    );
    return INVALID_TIME;
  }
  return minutesToHHmm(minutes);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Capitalised short weekday, as the day headers show it: "Mié", "Mon". */
export function formatWeekdayShort(date: string, language: string): string {
  return capitalizeFirst(
    new Intl.DateTimeFormat(intlLocaleOf(language), { weekday: 'short' })
      .format(localDateOf(date))
      // Some locales append a dot to the abbreviation; the wireframe has none.
      .replace(/\.$/, ''),
  );
}

/** Full weekday name, lower case as Spanish prose wants it: "jueves". */
export function formatWeekdayLong(date: string, language: string): string {
  return new Intl.DateTimeFormat(intlLocaleOf(language), { weekday: 'long' }).format(
    localDateOf(date),
  );
}

/** The day number alone: "12". */
export function formatDayOfMonth(date: string): string {
  return String(parseDate(date).day);
}

/** Short month name, no trailing dot: "ago", "Aug". */
export function formatMonthShort(date: string, language: string): string {
  return new Intl.DateTimeFormat(intlLocaleOf(language), { month: 'short' })
    .format(localDateOf(date))
    .replace(/\.$/, '');
}

/**
 * The long date the summary strip reads inside a sentence:
 * "jueves 27 de agosto", "Thursday 27 August".
 *
 * The comma `es-ES` puts after the weekday is removed, because the strip reads
 * "Taller ocupado hasta el jueves 27 de agosto" and "hasta el jueves, 27 de agosto"
 * is not how the shop would say it.
 */
export function formatLongDate(date: string, language: string): string {
  return new Intl.DateTimeFormat(intlLocaleOf(language), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
    .format(localDateOf(date))
    .replace(/,\s+/, ' ');
}

/** A compact date for lists and confirmations: "27 ago 2026". */
export function formatMediumDate(date: string, language: string): string {
  return new Intl.DateTimeFormat(intlLocaleOf(language), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
    .format(localDateOf(date))
    .replace(/\./g, '');
}

/** `YYYY-MM-DD` unchanged — what an `<input type="date">` expects. */
export function dateInputValue(date: string): string {
  return date;
}

/** ISO weekday of a local date, 1 = Monday .. 7 = Sunday. Re-exported for headers. */
export function weekdayNumber(date: string): number {
  return weekdayOf(date);
}

// ---------------------------------------------------------------------------
// The week range in the header
// ---------------------------------------------------------------------------

/**
 * Which locale key renders `10–16 ago 2026`, and the parts it interpolates.
 *
 * Three keys rather than one because a week can straddle a month or a year, and
 * where the shared month or year goes is a language decision, not a string-joining
 * one. The caller does `t(key, values)`.
 */
export interface WeekRangeLabel {
  key: string;
  values: Record<string, string>;
}

export function weekRangeLabel(
  startDate: string,
  endDate: string,
  language: string,
): WeekRangeLabel {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  const startDay = String(start.day);
  const endDay = String(end.day);
  const startMonth = formatMonthShort(startDate, language);
  const endMonth = formatMonthShort(endDate, language);
  const startYear = String(start.year);
  const endYear = String(end.year);

  if (start.year !== end.year) {
    return {
      key: 'header.weekRangeCrossYear',
      values: { startDay, startMonth, startYear, endDay, endMonth, endYear },
    };
  }

  if (start.month !== end.month) {
    return {
      key: 'header.weekRangeCrossMonth',
      values: { startDay, startMonth, endDay, endMonth, year: endYear },
    };
  }

  return {
    key: 'header.weekRangeSameMonth',
    values: { startDay, endDay, month: endMonth, year: endYear },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function capitalizeFirst(value: string): string {
  return value.length === 0 ? value : value[0].toLocaleUpperCase() + value.slice(1);
}
