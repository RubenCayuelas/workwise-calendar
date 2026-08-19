/**
 * The schedule strip's sentence, from the four `summary.*` keys. The week header
 * (`calendar/SummaryStrip.tsx`) and the create-job form both render it from HERE: while
 * two copies existed the four-way choice drifted apart within a day.
 */

import type { TranslateFn } from '../../lib/format';
import type { ScheduleSummary } from '../../lib/api-client';
import type { DayShape } from '../../types';

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

/**
 * "Relleno automático: 6 h de las 10 h de jornada", or `undefined` when the stop line
 * fills the whole shift.
 */
export function capacityNoticeMessage(
  shape: Pick<DayShape, 'capacityMinutes' | 'shiftMinutes'>,
  t: TranslateFn,
  format: Pick<SummaryFormatter, 'hourNumber'>,
): string | undefined {
  if (shape.shiftMinutes <= 0 || shape.capacityMinutes >= shape.shiftMinutes) return undefined;
  return t('summary.capacityBelowShift', {
    capacity: format.hourNumber(shape.capacityMinutes),
    shift: format.hourNumber(shape.shiftMinutes),
  });
}
