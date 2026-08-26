/**
 * The engine's numbers as what the owner reads. Pure and free of react-i18next: every function takes
 * the language as an argument (`useFormat()` binds it for a component). Minutes in, string out — 150
 * is "2,5" in Spanish, so never build an hour label with concatenation or `toFixed` — and a date is a
 * local `YYYY-MM-DD`, never an instant, so `localDateOf` is the only thing that turns one into a `Date`.
 */

import { MINUTES_PER_DAY, isoWeekNumber, minutesToHHmm, minutesToHours, parseDate } from './dates';
import { intlLocaleOf } from './i18n';

/** A translate function, structurally — so this module never imports i18next. */
export type TranslateFn = (key: string, values?: Record<string, unknown>) => string;

/**
 * The `Date` an `Intl` formatter needs for a local calendar day. Built from the parts at LOCAL MIDDAY,
 * far enough from either boundary that no DST transition (02:00/03:00 local) can push it onto the
 * neighbouring day.
 */
export function localDateOf(date: string): Date {
  const { year, month, day } = parseDate(date);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// Hours and times
// ---------------------------------------------------------------------------

/**
 * Minutes as the NUMBER part of an hours label: 360 -> "6", 150 -> "2,5" (es). The " h" lives in the
 * locale files (`units.hours`) because where the unit goes is a language decision; `useFormat().hours()`
 * gives the whole label.
 */
export function formatHourNumber(minutes: number, language: string): string {
  return new Intl.NumberFormat(intlLocaleOf(language), {
    maximumFractionDigits: 2,
  }).format(minutesToHours(minutes));
}

/** What a time outside the calendar day renders as: deliberately a shape no real time has. */
export const INVALID_TIME = '--:--';

/**
 * Minutes from midnight as a 24 h clock time: 480 -> "08:00".
 *
 * FAILS SOFT, and only here — `minutesToHHmm` still throws, which is right for the engine and every
 * write, but on the RENDER path that throw took the whole week view down. The console complaint names
 * BOTH suspects (a row stored out of range; a duration added to a start) because this cannot tell
 * them apart.
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
//
// Every weekday and month name comes from `Intl`, never from a list in the locale files. A
// hand-kept list drifted from CLDR: es-ES abbreviates September "sept" while the list said "sep",
// so two headers on the same page spelled the same month differently. The lists were deleted on
// 2026-08-20 once nothing read them.

/** Capitalised short weekday, as the day headers show it: "Mié", "Mon". */
export function formatWeekdayShort(date: string, language: string): string {
  return capitalizeFirst(
    new Intl.DateTimeFormat(intlLocaleOf(language), { weekday: 'short' })
      .format(localDateOf(date))
      // Some locales append a dot to the abbreviation; the wireframe has none.
      .replace(/\.$/, ''),
  );
}

/** The single-letter weekday a month grid heads its columns with: "L", "M". */
export function formatWeekdayNarrow(date: string, language: string): string {
  return new Intl.DateTimeFormat(intlLocaleOf(language), { weekday: 'narrow' }).format(
    localDateOf(date),
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
 * The month and year a month grid is titled with: "agosto 2026", "August 2026". Joined from Intl's
 * PARTS rather than its string, which for es-ES is "agosto de 2026" — dropping the literal parts
 * removes a connector that reads as prose in a heading, and does it without a Spanish word here.
 */
export function formatMonthYear(date: string, language: string): string {
  return new Intl.DateTimeFormat(intlLocaleOf(language), { month: 'long', year: 'numeric' })
    .formatToParts(localDateOf(date))
    .filter((part) => part.type === 'month' || part.type === 'year')
    .map((part) => part.value)
    .join(' ');
}

/**
 * The long date the summary strip reads inside a sentence: "jueves 27 de agosto". The comma `es-ES`
 * puts after the weekday is removed — the strip reads "hasta el jueves 27 de agosto", not "hasta el
 * jueves, 27 de agosto".
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

// ---------------------------------------------------------------------------
// The week range in the header
// ---------------------------------------------------------------------------

/**
 * Which locale key renders `10–16 ago 2026`, and the parts it interpolates. Three keys rather than one
 * because a week can straddle a month or a year, and where the shared month or year goes is a language
 * decision. The caller does `t(key, values)`.
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
// The day line under a date field
// ---------------------------------------------------------------------------

/**
 * "miércoles 12 de agosto · Semana 33" — the line a date field carries under itself. Takes `t`
 * directly, unlike `weekRangeLabel`: this joins three translated pieces (the long date, the week
 * number, the separator) rather than picking one key for the caller to translate.
 */
export function formatDayLine(date: string, language: string, t: TranslateFn): string {
  return [formatLongDate(date, language), t('units.week', { week: isoWeekNumber(date) })].join(
    t('units.listSeparator'),
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function capitalizeFirst(value: string): string {
  return value.length === 0 ? value : value[0].toLocaleUpperCase() + value.slice(1);
}
