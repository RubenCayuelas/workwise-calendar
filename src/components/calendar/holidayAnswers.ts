/**
 * What the holiday panel decides, apart from how it is drawn.
 *
 * A day whose work carries a padlock has NO choice to offer: displacing it would have to clear the
 * padlock, and the padlock is cleared by the padlock and nothing else. That day is stated, not asked
 * about, and it is answered `keep` whatever the control shows.
 */

import type { DayWorkRow, PendingHoliday } from '../../lib/api-client';

export function dayIsForced(rows: readonly DayWorkRow[]): boolean {
  return rows.some((row) => row.locked);
}

/** The minutes a day holds, summed over its jobs, for the one line that names the cost. */
export function dayMinutes(rows: readonly DayWorkRow[]): number {
  return rows.reduce((total, row) => total + row.minutes, 0);
}

/**
 * Every pending day's answer. A day the owner has not touched keeps the default — `false`, displace,
 * which is what closing a day has always done — and a forced day is `true` regardless.
 */
export function answersFrom(
  pending: readonly PendingHoliday[],
  chosen: ReadonlyMap<string, boolean>,
): Array<{ date: string; keep: boolean }> {
  return pending.map((day) => ({
    date: day.date,
    keep: dayIsForced(day.rows) ? true : (chosen.get(day.date) ?? false),
  }));
}
