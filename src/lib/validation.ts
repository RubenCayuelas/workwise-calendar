/**
 * Guards that are neither HTTP nor scheduling — the handful of things that must be
 * true of a row whoever is asking.
 *
 * Kept out of src/lib/api.ts because the operations enforce them too, and an
 * operation must not have to import `next/server` in order to check that a block
 * fits inside a day.
 */

import { MINUTES_PER_DAY, minutesToHHmm } from './dates';
import { ERROR_MESSAGE_KEYS, badRequest, conflict } from './errors';

/**
 * A block or a gap is a solid rectangle inside ONE calendar day: `duration` is net
 * working minutes and the week grid draws a day at a time, so a row running past
 * midnight has nowhere to be drawn and no meaning to the engine.
 *
 * This is the FRONT DOOR check, on coordinates a request supplied — a drop point, a
 * split. `assertRowInsideDay` is the same rule on the way OUT, at the write itself.
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
 * THE HARD GUARD ON THE WRITE PATH: no transaction may store a row whose start plus
 * duration runs past the end of its day.
 *
 * It exists because a rendering crash from bad stored data must be IMPOSSIBLE, not
 * merely unreachable through the paths that have been fixed. The defect it backs up was
 * an omission in `lastAutomatic` (src/lib/composition.ts): hours added to a job whose
 * last row sat on yesterday were written straight onto that row, so a 2 h row at 12:00
 * raised to 13 h became `12:00-25:00` — and the week view died on it with
 * `RangeError: Invalid minutes "1500"`, with no way back to the calendar from the UI.
 * One predicate fixed that path; this makes the SHAPE unstorable, whatever produces it.
 *
 * It is a refusal, not an assertion, because it is reachable by hand: *Block Resize* is
 * deliberately offered on past rows so yesterday can be corrected, and over HTTP the
 * duration is not capped by the drag layer's own limit. So it throws a 409 with an i18n
 * key naming the row, and the throw is what rolls the transaction back.
 *
 * Deliberately NOT the end of the working periods — a hand drop may legitimately sit in
 * a visual margin or run past the last period (see *A Drop Is Stored In Segments*). The
 * line is the calendar day itself, which is what the grid and every time label assume.
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
 * `HH:mm` for a real time of day, the raw number for anything else. A message about a
 * value being out of range must never itself throw on that value.
 */
function clockOrNumber(minutes: number): string {
  const renderable = Number.isFinite(minutes) && minutes >= 0 && minutes <= MINUTES_PER_DAY;
  return renderable ? minutesToHHmm(minutes) : String(minutes);
}
