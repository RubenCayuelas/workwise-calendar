/**
 * *Cerrar el día aquí*, read off a row — the ONE place the calendar works out what that
 * action would be, for the two surfaces that offer it.
 *
 * | surface | when |
 * |---------|------|
 * | the row's hover action bar (`WeekGrid`) | always, on a day there is something left to close |
 * | the toast a refused bottom-edge drag shows (`CalendarScreen`) | the edge does not size an automatic row, and this is what does end a day early |
 *
 * It exists as its own module because the second reader arrived on 2026-08-18 with the
 * hand-set duration's removal, and the two must not be able to propose different gaps
 * from the same row: the bar and the refusal are the same offer, reached two ways.
 *
 * **IT ONLY EVER PROPOSES.** The app never writes the gap — the owner does, in the form
 * this hands the request to: *«no se creará el hueco automáticamente, sino que si el
 * usuario lo quiere lo deberá de crear él»* (CLAUDE.md, *Capping a Day*).
 */

import type { WeekBlock, WeekDay } from '../../lib/api-client';
import type { Gap } from '../../types';
import { planCloseDay, type CloseDayInput, type CloseDayRequest } from '../../lib/closeDay';

/**
 * The day as the planner reads it, or `null` where the action makes no sense: the weekend
 * and a closed day have no plannable hours to cap, and the past is a record rather than a
 * plan.
 */
export function closeDayInputFor(
  day: WeekDay,
  blocks: readonly WeekBlock[],
  gaps: readonly Gap[],
): CloseDayInput | null {
  if (day.isPast || day.isWeekend || day.isClosed) return null;
  return {
    date: day.date,
    periods: day.periods,
    blocks: blocks.map((block) => ({
      id: block.id,
      projectId: block.projectId,
      name: block.project.name,
      startMinutes: block.startMinutes,
      durationMinutes: block.durationMinutes,
      locked: block.locked,
    })),
    gaps,
  };
}

/**
 * The "stop the day here" a row offers, or `null` when it has nothing to offer.
 *
 * The moment is the END of that row, so the action reads exactly as it is labelled: the
 * hours up to here stay today and the rest of the day stops being plannable. A row that
 * already runs to the end of the day, or one with nothing but existing gaps after it, has
 * nothing to close — the button is then absent rather than disabled, because there is no
 * state to explain.
 */
export function closeDayAfter(
  input: CloseDayInput | null,
  block: { startMinutes: number; durationMinutes: number },
): CloseDayRequest | null {
  if (input === null) return null;
  const fromMinutes = block.startMinutes + block.durationMinutes;
  const plan = planCloseDay(input, fromMinutes);
  if (plan === null || plan.workingMinutes <= 0) return null;
  return { input, fromMinutes };
}
