/**
 * The `settings` table — a facade, not a second implementation.
 *
 * `src/lib/settings.ts` already IS this table's repository: it owns the key/value
 * TEXT storage, the forgiving read path, the strict write path and the derived
 * `DayShape`. Re-implementing any of it here would give the schema two owners,
 * and the capacity re-cap would be the first thing to drift.
 *
 * This module exists so `src/lib/repositories/` really is one module per table and
 * a caller can reach every table through the same directory. It adds nothing but
 * the re-export.
 */

export {
  DEFAULT_SETTINGS,
  MAX_HORIZON_WEEKS,
  MAX_MARGIN_HOURS,
  MIN_HORIZON_WEEKS,
  MIN_MARGIN_HOURS,
  SettingsValidationError,
  dayShapeFromSettings,
  maxDayCapacityHours,
  normalizeSettings,
  readSettings,
  serializeSettings,
  validateSettings,
  workPeriodsOf,
  writeSettings,
} from '../settings';
