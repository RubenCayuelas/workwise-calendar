/**
 * Dates from the Junta, names from festivos.io, and a fallback for every date the second one does not
 * reach — which for a local holiday is the NORMAL first state, since the date is published months
 * before anyone names it.
 *
 * A fallback is composed from the locale files in the language the owner is READING: the name becomes
 * the day's stored note, so it is prose the data layer produces and cannot be re-translated after.
 * A name festivos.io supplies is passed through as it came — it is the source's own, not ours.
 */

import { publicHolidayName } from '../text';
import type { CachedHoliday } from '../repositories/holidays';
import type { JuntaHoliday } from './juntaDataset';
import { LOCAL_HOLIDAY_KEY, officialNameKey } from './officialNames';

export function composeHolidays(
  dates: readonly JuntaHoliday[],
  names: ReadonlyMap<string, string>,
  language?: string,
): CachedHoliday[] {
  return dates.map((holiday) => ({
    date: holiday.date,
    name: names.get(holiday.date) ?? fallbackName(holiday, language),
    level: holiday.level,
  }));
}

function fallbackName(holiday: JuntaHoliday, language?: string): string {
  if (holiday.level === 'local') return publicHolidayName(LOCAL_HOLIDAY_KEY, language);
  const key = officialNameKey(holiday.officialName);
  return key === undefined ? holiday.officialName : publicHolidayName(key, language);
}
