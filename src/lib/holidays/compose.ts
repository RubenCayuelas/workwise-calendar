/**
 * Dates from the Junta, names from festivos.io, and a fallback for every date the second one does not
 * reach — which for a local holiday is the NORMAL first state, since the date is published months
 * before anyone names it.
 */

import type { CachedHoliday } from '../repositories/holidays';
import type { JuntaHoliday } from './juntaDataset';
import { GENERIC_LOCAL_NAME, readableOfficialName } from './officialNames';

export function composeHolidays(
  dates: readonly JuntaHoliday[],
  names: ReadonlyMap<string, string>,
): CachedHoliday[] {
  return dates.map((holiday) => ({
    date: holiday.date,
    name: names.get(holiday.date) ?? fallbackName(holiday),
    level: holiday.level,
  }));
}

function fallbackName(holiday: JuntaHoliday): string {
  if (holiday.level === 'local') return GENERIC_LOCAL_NAME;
  return readableOfficialName(holiday.officialName) ?? holiday.officialName;
}
