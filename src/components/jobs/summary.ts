/**
 * The schedule strip's sentence, from the four `summary.*` keys.
 *
 * It lives here because the create-job form needs it: CLAUDE.md appends a new job
 * "after the last existing block", so "Taller ocupado hasta el jueves 27 de agosto"
 * IS the answer to "where will this land", and showing it before saving is the
 * cheapest way to keep the owner unsurprised.
 *
 * The week view's header strip renders the same sentence from this same function
 * (`calendar/SummaryStrip.tsx`). It has to: when the two existed side by side the
 * four-way choice (booked/free × Friday clear/busy) drifted within a day — the strip
 * was fixed to print a medium buffer date and this copy still printed a long one, so
 * the create-job form read "el viernes viernes 14 de agosto". One function, one bug to
 * fix, and `summary.test.ts` pins the wording rule that caused it.
 */

import type { TranslateFn } from '../../lib/format';
import type { ScheduleSummary } from '../../lib/api-client';

/** Just the parts of `useFormat()`'s result this needs, so it is testable without React. */
export interface SummaryFormatter {
  hourNumber: (minutes: number) => string;
  longDate: (date: string) => string;
  mediumDate: (date: string) => string;
}

export function scheduleSummaryMessage(
  summary: ScheduleSummary,
  t: TranslateFn,
  format: SummaryFormatter,
): string {
  const hours = format.hourNumber(summary.queuedMinutes);
  // MEDIUM, not long: both languages already write the word "Friday" into the two
  // `*FridayBusy` sentences, so a long date reads "el viernes viernes 14 de agosto".
  const bufferDate = format.mediumDate(summary.bufferDate);

  if (summary.lastOccupiedDate === null) {
    return summary.bufferClear
      ? t('summary.freeFridayFree')
      : t('summary.freeFridayBusy', { bufferDate });
  }

  const date = format.longDate(summary.lastOccupiedDate);
  return summary.bufferClear
    ? t('summary.bookedFridayFree', { date, hours })
    : t('summary.bookedFridayBusy', { date, hours, bufferDate });
}
