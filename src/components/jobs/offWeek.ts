/**
 * A form's chosen day leaving the week on screen, while a painted band is still being drawn on it.
 *
 * The date is set OPTIMISTICALLY — the band has to follow the field — and this decides what to offer
 * afterwards. It is triggered by the FIELD CHANGING, never by visibility: paging the week with the
 * header arrows while a form is open would otherwise ask "shall we go to that week?" the instant the
 * owner deliberately left it.
 */

import { isValidDate } from '../../lib/dates';

export interface OffWeekChoice {
  /** The week to travel to. */
  goTo: string;
  /**
   * The last day chosen that WAS on screen. Not simply the previous value: moving Sep 1 to Sep 8
   * would offer Sep 1, which is off screen too, and the owner would be stranded with nothing to
   * press. `null` when no visible day has been chosen yet.
   */
  backTo: string | null;
}

export function offWeekChoice(
  date: string,
  visibleDates: readonly string[],
  lastVisible: string | null,
): OffWeekChoice | null {
  if (!isValidDate(date) || visibleDates.length === 0) return null;
  if (visibleDates.includes(date)) return null;
  return { goTo: date, backTo: lastVisible };
}
