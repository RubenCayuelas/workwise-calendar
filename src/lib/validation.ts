/**
 * Guards that are neither HTTP nor scheduling — the handful of things that must be
 * true of a row whoever is asking.
 *
 * Kept out of src/lib/api.ts because the operations enforce them too, and an
 * operation must not have to import `next/server` in order to check that a block
 * fits inside a day.
 */

import { MINUTES_PER_DAY } from './dates';
import { ERROR_MESSAGE_KEYS, badRequest } from './errors';

/**
 * A block or a gap is a solid rectangle inside ONE calendar day: `duration` is net
 * working minutes and the week grid draws a day at a time, so a row running past
 * midnight has nowhere to be drawn and no meaning to the engine.
 */
export function assertFitsInDay(startMinutes: number, durationMinutes: number): void {
  if (startMinutes + durationMinutes > MINUTES_PER_DAY) {
    throw badRequest('out-of-range', ERROR_MESSAGE_KEYS.invalidTime, {
      field: 'startMinutes',
      details: { startMinutes, durationMinutes, endOfDayMinutes: MINUTES_PER_DAY },
    });
  }
}
