/**
 * Which DAYS a range of absence covers. Both modes of the absences screen read it — one gap repeated
 * on every day, or one closed day each — and so do the preview and the save, so no two of them can
 * disagree about what "1 to 4 September" means.
 */

import { addDays, compareDates, isWeekend } from './dates';

/** The longest range that may be asked for: past it a mistyped year closes a decade. */
export const MAX_ABSENCE_DAYS = 120;

export interface AbsenceRange {
  /** The days that will be written, in calendar order. */
  dates: string[];
  /** Weekend days the range dropped. Named on screen, so the skip is never silent. */
  skipped: string[];
}

/**
 * `from` and `to` inclusive. Saturday and Sunday are dropped, because they are outside the engine and
 * an absence there changes nothing — UNLESS every day of the range is one, which is the owner naming
 * a weekend on purpose. The walk is bounded by `MAX_ABSENCE_DAYS`; callers refuse a longer span
 * before asking.
 */
export function absenceRange(from: string, to: string): AbsenceRange {
  const span: string[] = [];
  for (
    let date = from;
    compareDates(date, to) <= 0 && span.length < MAX_ABSENCE_DAYS;
    date = addDays(date, 1)
  ) {
    span.push(date);
  }

  if (span.length > 0 && span.every(isWeekend)) return { dates: span, skipped: [] };
  return { dates: span.filter((date) => !isWeekend(date)), skipped: span.filter(isWeekend) };
}
