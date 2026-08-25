/**
 * festivos.io, read for ONE thing: the human name of a day. Its own `source.ref` on the Andalusian
 * local rows names the Junta dataset, so it is a naming layer over the same official data rather than
 * a second opinion about the dates — and it publishes a year months after the Junta does.
 *
 * A body it cannot read is an EMPTY MAP and never a throw: a missing name is not a failed check.
 */

import { isValidDate } from '../dates';

export function parseFestivosIo(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (payload === null || typeof payload !== 'object') return names;
  const holidays = (payload as { holidays?: unknown }).holidays;
  if (!Array.isArray(holidays)) return names;

  for (const entry of holidays) {
    if (entry === null || typeof entry !== 'object') continue;
    const { date, name } = entry as { date?: unknown; name?: unknown };
    if (typeof date !== 'string' || !isValidDate(date)) continue;
    if (name === null || typeof name !== 'object') continue;
    const spanish = (name as { es?: unknown }).es;
    if (typeof spanish !== 'string' || spanish.trim() === '') continue;
    names.set(date, spanish.trim());
  }
  return names;
}
