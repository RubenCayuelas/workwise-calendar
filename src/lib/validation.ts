/**
 * Guards that are neither HTTP nor scheduling: the operations enforce them too, so they must not have
 * to import `next/server` in order to check that a block fits inside a day.
 */

import { MINUTES_PER_DAY, minutesToHHmm } from './dates';
import { ERROR_MESSAGE_KEYS, badRequest, conflict } from './errors';

/**
 * A block or a gap is a solid rectangle inside ONE calendar day, so a row running past midnight has
 * nowhere to be drawn. The FRONT DOOR check, on coordinates a request supplied; `assertRowInsideDay`
 * is the same rule on the way OUT, at the write itself.
 */
export function assertFitsInDay(startMinutes: number, durationMinutes: number): void {
  if (startMinutes + durationMinutes > MINUTES_PER_DAY) {
    throw badRequest('out-of-range', ERROR_MESSAGE_KEYS.invalidTime, {
      field: 'startMinutes',
      details: { startMinutes, durationMinutes, endOfDayMinutes: MINUTES_PER_DAY },
    });
  }
}

/** A stored row, as much of it as this guard needs to name the offender. */
export interface RowExtent {
  id?: string;
  date: string;
  startMinutes: number;
  durationMinutes: number;
}

/**
 * The hard guard on the write path: no transaction may store a row whose start plus duration runs past
 * the end of its day, so a rendering crash from bad stored data is IMPOSSIBLE rather than merely
 * unreachable through the paths that have been fixed. A refusal and not an assertion, because it is
 * reachable over HTTP, and the throw is what rolls the transaction back. The line is MIDNIGHT,
 * deliberately not the end of the working periods: a hand drop may legitimately sit in a visual margin
 * or run past the last period.
 */
export function assertRowInsideDay(row: RowExtent): void {
  const end = row.startMinutes + row.durationMinutes;
  if (Number.isFinite(end) && row.startMinutes >= 0 && end <= MINUTES_PER_DAY) return;

  throw conflict('row-exceeds-day', ERROR_MESSAGE_KEYS.rowExceedsDay, {
    field: 'durationMinutes',
    details: {
      ...(row.id === undefined ? {} : { blockId: row.id }),
      date: row.date,
      startTime: clockOrNumber(row.startMinutes),
      startMinutes: row.startMinutes,
      durationMinutes: row.durationMinutes,
      endOfDayMinutes: MINUTES_PER_DAY,
    },
  });
}

/**
 * The smallest row the calendar can draw or the owner can aim at. Held equal to the drag layer's
 * `SNAP_MINUTES` and the `TimeSelect` step by a test; a shorter row cannot show its own hours
 * (`MIN_LABEL_HEIGHT`). A FRONT-DOOR floor on the gestures that name a duration outright, and
 * deliberately not a write-path guard.
 */
export const MIN_ROW_MINUTES = 15;

/**
 * The other line, and the one the owner sees: the end of the day's last MANUAL window — every minute
 * a hand gesture may use. `storedEndMinutes` keeps it honest about the one shape that legitimately
 * sits outside the windows, a row the owner put in a margin that was LATER set to 0: the rule is not
 * "every stored row ends inside the day", which would refuse every unrelated save on that calendar,
 * but NO WRITE MAY MAKE AN OVERRUN WORSE.
 */
export function assertRowWithinDayEnd(
  row: RowExtent,
  dayEndMinutes: number,
  storedEndMinutes?: number,
): void {
  const end = row.startMinutes + row.durationMinutes;
  if (end <= dayEndMinutes) return;
  if (storedEndMinutes !== undefined && end <= storedEndMinutes) return;

  throw conflict('row-past-day-end', ERROR_MESSAGE_KEYS.rowPastDayEnd, {
    field: 'durationMinutes',
    details: {
      ...(row.id === undefined ? {} : { blockId: row.id }),
      date: row.date,
      startTime: clockOrNumber(row.startMinutes),
      endTime: clockOrNumber(end),
      dayEndTime: clockOrNumber(dayEndMinutes),
      startMinutes: row.startMinutes,
      durationMinutes: row.durationMinutes,
      dayEndMinutes,
    },
  });
}

/**
 * `HH:mm` for a real time of day, the raw number for anything else: a message about a value being out
 * of range must never itself throw on that value.
 */
function clockOrNumber(minutes: number): string {
  const renderable = Number.isFinite(minutes) && minutes >= 0 && minutes <= MINUTES_PER_DAY;
  return renderable ? minutesToHHmm(minutes) : String(minutes);
}
