/**
 * *Cerrar el día aquí*, read off a row. Its two readers — the hover bar and the toast a refused
 * resize shows — must not propose different gaps from one row, so both come through here.
 * It only ever PROPOSES.
 */

import type { WeekBlock, WeekDay } from '../../lib/api-client';
import type { Gap } from '../../types';
import { planCloseDay, type CloseDayInput, type CloseDayRequest } from '../../lib/closeDay';

/** The day as the planner reads it, or `null` where there is nothing to cap. */
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
 * The "stop the day here" a row offers, from the END of that row, or `null` when it has
 * nothing to offer — a row already running to the end of the day, or with only gaps after
 * it. The button is then absent rather than disabled: there is no state to explain.
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
