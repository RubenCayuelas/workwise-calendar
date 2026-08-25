/**
 * What closing a day decides about the work already on it, shared by the two doors that ask: the
 * automatic holiday check and the absences form. One module, because two answers to the same question
 * is exactly the drift the rule against it exists to stop.
 *
 * A day whose work carries a padlock has NO choice to offer: moving it on would have to clear the
 * padlock, and the padlock is cleared by the padlock and nothing else. Such a day is stated, not asked
 * about, and it keeps its work whatever the control shows.
 */

import type { DayWork, DayWorkRow, PendingHoliday } from '../../lib/api-client';

export function dayIsForced(rows: readonly DayWorkRow[]): boolean {
  return rows.some((row) => row.locked);
}

/** The minutes a day holds, summed over its jobs, for the one line that names the cost. */
export function dayMinutes(rows: readonly DayWorkRow[]): number {
  return rows.reduce((total, row) => total + row.minutes, 0);
}

/** The decision for one day, written once so both doors cannot answer it differently. */
export function keepsWork(
  day: { date: string; rows: readonly DayWorkRow[] },
  chosen: ReadonlyMap<string, boolean>,
): boolean {
  return dayIsForced(day.rows) ? true : (chosen.get(day.date) ?? false);
}

/** The holiday panel's shape: an answer per day, including the ones that had no choice. */
export function answersFrom(
  pending: readonly PendingHoliday[],
  chosen: ReadonlyMap<string, boolean>,
): Array<{ date: string; keep: boolean }> {
  return pending.map((day) => ({ date: day.date, keep: keepsWork(day, chosen) }));
}

/** The absences form's shape: `keepWork`, the dates whose work stays where it is. */
export function keepWorkDates(
  days: readonly DayWork[],
  chosen: ReadonlyMap<string, boolean>,
): string[] {
  return days.filter((day) => keepsWork(day, chosen)).map((day) => day.date);
}
