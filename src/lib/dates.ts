/**
 * The single source of truth for dates and clock arithmetic.
 *
 * Two hard rules the rest of the app depends on:
 *
 * 1. A calendar day is a LOCAL `YYYY-MM-DD` string in the shop's timezone
 *    (Europe/Madrid). It is never derived from a UTC timestamp: SQLite's
 *    `CURRENT_TIMESTAMP` is UTC, so anything saved after 22:00 local would land
 *    on the wrong day. `todayLocal()` is the only door from an instant to a day.
 *
 * 2. Times of day are INTEGER MINUTES FROM MIDNIGHT. Decimal hours exist only at
 *    the database boundary (REAL columns) and in what the user reads, which is
 *    what `hoursToMinutes` / `minutesToHours` are for. Keeping the engine on
 *    integers removes float drift on values like 2.5 h.
 *
 * Everything here is pure. "Now" is an injected parameter so tests are
 * deterministic. Day arithmetic runs in UTC on purpose: UTC has no DST, so
 * adding a day can never skip or repeat one. The UTC instant is an internal
 * carrier for the local date parts, never a timestamp with a meaning of its own.
 */

export const SHOP_TIME_ZONE = 'Europe/Madrid';

export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/** 1 = Monday .. 7 = Sunday (ISO-8601). */
export const MONDAY = 1;
export const FRIDAY = 5;
export const SATURDAY = 6;
export const SUNDAY = 7;

const MS_PER_DAY = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/** A calendar day taken apart. `month` is 1-12, not 0-11. */
export interface DateParts {
  year: number;
  month: number;
  day: number;
}

// ---------------------------------------------------------------------------
// Parsing and formatting
// ---------------------------------------------------------------------------

/**
 * Splits a `YYYY-MM-DD` string. Throws on anything that is not a real calendar
 * day, so `2026-02-30` is rejected rather than silently rolling into March.
 */
export function parseDate(date: string): DateParts {
  const match = DATE_PATTERN.exec(date);
  if (!match) {
    throw new RangeError(`Invalid date "${date}": expected YYYY-MM-DD`);
  }
  const parts: DateParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  if (formatDate(parts) !== date) {
    throw new RangeError(`Invalid date "${date}": no such calendar day`);
  }
  return parts;
}

/** Renders date parts as `YYYY-MM-DD`, normalising out-of-range values. */
export function formatDate(parts: DateParts): string {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return fromUtcInstant(utc);
}

/** True when `date` is a well-formed local calendar day. */
export function isValidDate(date: string): boolean {
  try {
    parseDate(date);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// "Today" in the shop's timezone
// ---------------------------------------------------------------------------

/** Today as a local `YYYY-MM-DD` in the shop's timezone. */
export function todayLocal(now: Date = new Date(), timeZone: string = SHOP_TIME_ZONE): string {
  return instantToLocalDate(now, timeZone);
}

/** Projects an instant onto the calendar day it falls on in `timeZone`. */
export function instantToLocalDate(instant: Date, timeZone: string = SHOP_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((part) => part.type === type);
    if (!found) throw new Error(`Missing "${type}" while formatting a date`);
    return found.value;
  };

  return `${get('year')}-${get('month')}-${get('day')}`;
}

// ---------------------------------------------------------------------------
// Day arithmetic
// ---------------------------------------------------------------------------

/** Shifts a day by whole days. Negative values go backwards. */
export function addDays(date: string, days: number): string {
  return fromUtcInstant(new Date(toUtcInstant(date).getTime() + Math.trunc(days) * MS_PER_DAY));
}

/** Signed whole days from `from` to `to` (`to - from`). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcInstant(to).getTime() - toUtcInstant(from).getTime()) / MS_PER_DAY);
}

/** ISO weekday: 1 = Monday .. 7 = Sunday. */
export function weekdayOf(date: string): number {
  return ((toUtcInstant(date).getUTCDay() + 6) % 7) + 1;
}

/** True for Saturday and Sunday — the days the engine never touches. */
export function isWeekend(date: string): boolean {
  return weekdayOf(date) >= SATURDAY;
}

/** The Monday of the week containing `date`. */
export function startOfWeek(date: string): string {
  return addDays(date, -(weekdayOf(date) - MONDAY));
}

/** The seven days Monday..Sunday of the week containing `date`. */
export function weekDates(date: string): string[] {
  const monday = startOfWeek(date);
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

/** ISO-8601 week number (1-53); week 1 is the one containing the first Thursday. */
export function isoWeekNumber(date: string): number {
  const thursday = isoWeekThursday(date);
  const firstThursday = isoWeekThursday(fromUtcInstant(new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4))));
  return 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
}

/** The calendar year the ISO week belongs to — differs from the date's own year at year ends. */
export function isoWeekYear(date: string): number {
  return isoWeekThursday(date).getUTCFullYear();
}

/** Comparator for `Array.prototype.sort`: negative, zero or positive. */
export function compareDates(a: string, b: string): number {
  parseDate(a);
  parseDate(b);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Clock conversions
// ---------------------------------------------------------------------------

/** Parses `"08:00"` into minutes from midnight. Accepts `"8:00"`; `"24:00"` is the end of the day. */
export function hhmmToMinutes(time: string): number {
  const match = TIME_PATTERN.exec(time);
  if (!match) {
    throw new RangeError(`Invalid time "${time}": expected HH:mm`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) {
    throw new RangeError(`Invalid time "${time}": minutes must be 00-59`);
  }
  const total = hours * MINUTES_PER_HOUR + minutes;
  if (total > MINUTES_PER_DAY) {
    throw new RangeError(`Invalid time "${time}": past the end of the day`);
  }
  return total;
}

/** Renders minutes from midnight as `HH:mm`. */
export function minutesToHHmm(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > MINUTES_PER_DAY) {
    throw new RangeError(`Invalid minutes "${minutes}": expected 0-${MINUTES_PER_DAY}`);
  }
  const whole = Math.round(minutes);
  const hours = Math.floor(whole / MINUTES_PER_HOUR);
  const rest = whole % MINUTES_PER_HOUR;
  return `${pad2(hours)}:${pad2(rest)}`;
}

/** Decimal hours (database boundary) to integer minutes (everywhere else). */
export function hoursToMinutes(hours: number): number {
  if (!Number.isFinite(hours)) {
    throw new RangeError(`Invalid hours "${hours}"`);
  }
  return Math.round(hours * MINUTES_PER_HOUR);
}

/** Integer minutes back to decimal hours, for storage and for display. */
export function minutesToHours(minutes: number): number {
  if (!Number.isFinite(minutes)) {
    throw new RangeError(`Invalid minutes "${minutes}"`);
  }
  return Math.round(minutes) / MINUTES_PER_HOUR;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Local date parts carried as a UTC instant, so arithmetic ignores DST. */
function toUtcInstant(date: string): Date {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day));
}

function fromUtcInstant(instant: Date): string {
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError('Invalid date: out of range');
  }
  return `${padYear(instant.getUTCFullYear())}-${pad2(instant.getUTCMonth() + 1)}-${pad2(instant.getUTCDate())}`;
}

/** The Thursday of the ISO week containing `date` — the week's identity anchor. */
function isoWeekThursday(date: string): Date {
  const instant = toUtcInstant(date);
  const mondayOffset = (instant.getUTCDay() + 6) % 7;
  return new Date(instant.getTime() + (3 - mondayOffset) * MS_PER_DAY);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function padYear(value: number): string {
  return String(value).padStart(4, '0');
}
