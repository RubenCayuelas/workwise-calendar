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
  /** A save above it is refused. */
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
 * No intent is passed to `recompose`, so displaced hours go to the next auto-fill day
 * rather than onto the Friday colchón. NARROWING the horizon can fail with
 * `horizon-exceeded`, which rolls the save back.
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
        // `error.message` is an English developer sentence for the console; the UI words
        // the failure from `messageKey` and highlights `field`.
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
 * Drops keys whose value is `undefined`. `writeSettings` merges by spread, which does NOT
 * skip an explicitly-undefined key, so `{ period2Enabled: false }` arriving from a route
 * that read every optional field also carries `period1Start: undefined` — which would wipe
 * the stored time and then fail validation on it. Filtered here, not at the route.
 */
function definedFieldsOf(patch: Partial<Settings>): Partial<Settings> {
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) defined[key] = value;
  }
  return defined as Partial<Settings>;
}
