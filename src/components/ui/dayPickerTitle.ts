/**
 * What a cell of the day calendar says on hover. Kept out of the component so it can be decided
 * without a DOM: the component only spells the kinds this returns.
 */

import type { MonthCell } from './monthGrid';
import type { DayMark } from './pickerDays';

/** One line of a cell's tooltip, as a KIND: the switch that words them lives in one place. */
export type DayCellNote = 'today' | 'weekend' | 'closed' | 'note' | 'freeHours' | 'full';

export function dayCellNotes(cell: MonthCell, mark: DayMark | undefined): DayCellNote[] {
  const notes: DayCellNote[] = [];

  if (cell.isToday) notes.push('today');
  if (cell.isWeekend) notes.push('weekend');

  if (mark === undefined) return notes;

  // The owner's own words are the state of a closed day: the grey cell already says "cerrado",
  // and the reason is the only thing it cannot say.
  if (mark.isClosed) notes.push(mark.note === undefined ? 'closed' : 'note');

  if (mark.freeMinutes > 0) notes.push('freeHours');
  // A weekend, a past day and a closed one have no plannable hours to be full of.
  else if (!cell.isPast && !cell.isWeekend && !mark.isClosed) notes.push('full');

  return notes;
}
