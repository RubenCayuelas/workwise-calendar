/**
 * The Settings screen's write path.
 *
 * `src/lib/settings.ts` already validates and stores; the only thing added here is
 * the consequence of a change. Periods, capacity and the horizon are inputs to
 * every day's plannable hours, so a settings write that did not recompose could
 * leave rows sitting in time that is no longer a working period — shortening the
 * afternoon would strand blocks after the new end of day. So the write and the
 * reflow share one transaction: if the reflow cannot be satisfied, the settings
 * change is rolled back with it and nothing is half-applied.
 *
 * Worth knowing before the UI shows the response: `writeSettings` returns the
 * EFFECTIVE settings, which may differ from what was submitted. `defaultDayCapacity`
 * is a stop line derived from the shift, so shortening the periods (or switching the
 * afternoon off) re-caps it instead of rejecting the save. The Settings form must
 * render the returned values rather than its own state, or the re-cap is invisible.
 */

import { getDb, type Db } from '../db';
import { todayLocal } from '../dates';
import type { ScheduleSummary } from '../composition';
import { badRequest, ERROR_MESSAGE_KEYS } from '../errors';
import { recompose, runTransaction } from '../scheduler';
import {
  SettingsValidationError,
  dayShapeFromSettings,
  maxDayCapacityHours,
  readSettings,
  writeSettings,
} from '../settings';
import type { DayShape, Settings } from '../../types';

export interface SettingsView {
  settings: Settings;
  /** The minutes view the grid draws: periods, capacity, the 07:00-20:30 timeline. */
  shape: DayShape;
  /** The ceiling the capacity field must not exceed, given the current periods. */
  maxDayCapacityHours: number;
}

export function readSettingsView(db: Db = getDb()): SettingsView {
  const settings = readSettings(db);
  return { settings, shape: dayShapeFromSettings(settings), maxDayCapacityHours: maxDayCapacityHours(settings) };
}

export interface UpdateSettingsResult extends SettingsView {
  summary: ScheduleSummary;
}

/**
 * Validates, saves and reflows in one transaction.
 *
 * No intent is passed to `recompose`: a capacity or period change is not the growth
 * of a job, so displaced hours go to the next auto-fill day rather than onto the
 * Friday colchón. One consequence to surface in the UI: NARROWING the planning
 * horizon can fail with `horizon-exceeded` if the queued work no longer fits inside
 * it, and that failure rolls the settings change back.
 */
export function updateSettings(
  patch: Partial<Settings>,
  options: { today?: string } = {},
  db: Db = getDb(),
): UpdateSettingsResult {
  const today = options.today ?? todayLocal();

  return runTransaction(db, () => {
    let settings: Settings;
    try {
      settings = writeSettings(definedFieldsOf(patch), db);
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        // `error.message` is an English developer sentence; it travels in `details`
        // for the console while the UI words the failure from `messageKey` and
        // highlights `field`.
        throw badRequest('settings-invalid', ERROR_MESSAGE_KEYS.settingsInvalid, {
          field: error.field,
          details: { reason: error.message },
        });
      }
      throw error;
    }

    const report = recompose(db, { today });
    return {
      settings,
      shape: dayShapeFromSettings(settings),
      maxDayCapacityHours: maxDayCapacityHours(settings),
      summary: report.summary,
    };
  });
}

/**
 * Drops keys whose value is `undefined`.
 *
 * `writeSettings` merges with `{ ...stored, ...patch }`, and a spread does not skip
 * an explicitly-undefined key — it overwrites with `undefined`. A PATCH route reads
 * every optional field and passes what it found, so `{ period2Enabled: false }` over
 * the wire arrives as an object that also carries `period1Start: undefined`, which
 * would wipe the stored time and then fail validation on it. Filtering here rather
 * than at the route keeps every future caller of `updateSettings` safe from the same
 * trap. (The repositories are already immune: they test each key with `!== undefined`
 * instead of spreading.)
 */
function definedFieldsOf(patch: Partial<Settings>): Partial<Settings> {
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) defined[key] = value;
  }
  return defined as Partial<Settings>;
}
