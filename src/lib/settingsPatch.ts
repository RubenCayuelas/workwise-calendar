/**
 * What a `PATCH /api/settings` body is allowed to carry, read field by field.
 *
 * The route named its fields by hand and the list had drifted six behind `Settings`: the screen sent
 * them, the route dropped them, and `updateSettings` echoed the OLD value back — which the form then
 * wrote over its own control, so the save reported success and changed nothing. `READERS` is a RECORD
 * OVER `Settings`, so a field added without a reader is a compile error rather than a silent omission.
 */

import { readFlag, readText, type JsonBody } from './api';
import { ERROR_MESSAGE_KEYS, badRequest } from './errors';
import type { Settings } from '../types';

type Reader<K extends keyof Settings> = (body: JsonBody, key: K) => Settings[K] | undefined;

/** Only that it IS a number: every bound belongs to `validateSettings`, or it gets two owners. */
function readNumber(body: JsonBody, key: keyof Settings): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, key) || body[key] === undefined) return undefined;
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest('invalid-field', ERROR_MESSAGE_KEYS.settingsInvalid, { field: key });
  }
  return value;
}

const READERS: { [K in keyof Settings]: Reader<K> } = {
  period1Start: readText,
  period1End: readText,
  period2Start: readText,
  period2End: readText,
  period2Enabled: readFlag,
  defaultDayCapacity: readNumber,
  visualMarginTop: readNumber,
  visualMarginBottom: readNumber,
  planningHorizonWeeks: readNumber,
  gapColor: readText,
  backupsEnabled: readFlag,
  backupEveryDays: readNumber,
  backupsKept: readNumber,
  holidaysEnabled: readFlag,
  holidaysMunicipality: readText,
  nowLineEnabled: readFlag,
};

export function settingsPatchOf(body: JsonBody): Partial<Settings> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(READERS) as (keyof Settings)[]) {
    const value = (READERS[key] as Reader<keyof Settings>)(body, key);
    if (value !== undefined) patch[key] = value;
  }
  return patch as Partial<Settings>;
}
