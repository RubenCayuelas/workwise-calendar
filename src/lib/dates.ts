/**
 * Dates and clock arithmetic; pure, with "now" injected. A day is a LOCAL `YYYY-MM-DD` and
 * `todayLocal()` is the only door from an instant to one; a time of day is integer minutes.
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

/**
 * An instant as `YYYY-MM-DD-HHmm` in `timeZone` — a filename that sorts chronologically. Here rather
 * than at the caller so the shop's timezone is still read in exactly one module.
 */
export function instantToLocalStamp(instant: Date, timeZone: string = SHOP_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((part) => part.type === type);
    if (!found) throw new Error(`Missing "${type}" while formatting a time`);
    return found.value;
  };

  return `${instantToLocalDate(instant, timeZone)}-${get('hour')}${get('minute')}`;
}

// ---------------------------------------------------------------------------
// Day arithmetic
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Month arithmetic
// ---------------------------------------------------------------------------

/** The first day of the month containing `date`. */
export function startOfMonth(date: string): string {
  const { year, month } = parseDate(date);
  return formatDate({ year, month, day: 1 });
}

/** The last day of the month containing `date`. */
export function endOfMonth(date: string): string {
  const { year, month } = parseDate(date);
  // Day 0 of the next month, which formatDate normalises: no table of month lengths, and no leap
  // year rule to keep.
  return formatDate({ year, month: month + 1, day: 0 });
}

/** `date` shifted by whole months, CLAMPED to the target month's last day. */
export function addMonths(date: string, months: number): string {
  const { year, month, day } = parseDate(date);
  const shifted = month + Math.trunc(months);
  const lastDay = parseDate(formatDate({ year, month: shifted + 1, day: 0 })).day;
  return formatDate({ year, month: shifted, day: Math.min(day, lastDay) });
}

export function isSameMonth(a: string, b: string): boolean {
  const left = parseDate(a);
  const right = parseDate(b);
  return left.year === right.year && left.month === right.month;
}

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

export function minutesToHHmm(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > MINUTES_PER_DAY) {
    throw new RangeError(`Invalid minutes "${minutes}": expected 0-${MINUTES_PER_DAY}`);
  }
  const whole = Math.round(minutes);
  const hours = Math.floor(whole / MINUTES_PER_HOUR);
  const rest = whole % MINUTES_PER_HOUR;
  return `${pad2(hours)}:${pad2(rest)}`;
}

export function hoursToMinutes(hours: number): number {
  if (!Number.isFinite(hours)) {
    throw new RangeError(`Invalid hours "${hours}"`);
  }
  return Math.round(hours * MINUTES_PER_HOUR);
}

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
