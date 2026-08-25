/**
 * The public-holiday pass: fetch the municipality's holidays, close the ones that displace nothing,
 * and hand back the ones with work on them for the owner to answer.
 *
 * THE OWNERSHIP RULE governs everything here. A future day whose note is EXACTLY what the last check
 * wrote there is the app's to correct — renamed when a better name arrives, reopened when the date
 * stops being a holiday. The moment the owner edits that note, closes the day themselves or reopens
 * it, the day is theirs and the app never writes on it again. The comparison is against the `holidays`
 * cache, which is why the cache is read before it is replaced.
 */

import { getDb, type Db } from '../db';
import { compareDates, todayLocal } from '../dates';
import { AppError } from '../errors';
import { runTransaction } from '../scheduler';
import { readSettings } from '../settings';
import { findDayOverride, upsertDayOverride } from '../repositories/dayOverrides';
import {
  listCachedHolidays,
  readHolidayCheck,
  recordHolidayCheck,
  replaceCachedHolidays,
  type CachedHoliday,
} from '../repositories/holidays';
import { composeHolidays } from '../holidays/compose';
import { parseFestivosIo } from '../holidays/festivosIo';
import { HTTP_SOURCE, type HolidaySource } from '../holidays/fetch';
import { holidaysForMunicipality } from '../holidays/juntaDataset';
import { ANDALUSIAN_PROVINCES, findMunicipality } from '../holidays/municipalities';
import { reopenDays, saveAbsence, workByDay, type DayWorkRow } from './absences';

/** Holidays move once a year; a weekly look is generous. The button covers the hurry. */
export const CHECK_EVERY_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A holiday that has work on it: nothing was written, and the owner is being asked. */
export interface PendingHoliday {
  date: string;
  name: string;
  rows: DayWorkRow[];
}

/** A holiday the write refused, with the code that refused it. The rest of the pass still ran. */
export interface RefusedHoliday {
  date: string;
  name: string;
  code: string;
}

/** What Settings shows, and what the panel needs to know about the check behind it. */
export interface HolidayState {
  enabled: boolean;
  municipality: string;
  /** Empty when the stored code names no Andalusian municipality. */
  municipalityName: string;
  count: number;
  /** The furthest holiday the app knows about — how far the source reaches, in one date. */
  knownThrough: string | null;
  lastCheckedAt: string | null;
  lastCheckSucceeded: boolean;
}

export interface HolidayCheckResult {
  /** Why nothing happened, so the caller can stay quiet rather than guess. */
  skipped?: 'disabled' | 'not-due' | 'offline';
  /** Days closed with no question asked. */
  closed: string[];
  /** Days renamed in place. Never reopened and rewritten — see `renameDay`. */
  renamed: string[];
  /** Days reopened because they stopped being holidays. */
  reopened: string[];
  /** Days with work on them. NOTHING was written for these; they are waiting for an answer. */
  pending: PendingHoliday[];
  refused: RefusedHoliday[];
  state: HolidayState;
}

export interface HolidayCheckOptions {
  today?: string;
  now?: Date;
  /** The "check now" button: skips the weekly wait, never the switch. */
  force?: boolean;
  source?: HolidaySource;
  /**
   * The language the owner is READING. A holiday's name becomes the day's stored note, so it cannot
   * be re-translated afterwards — the same reason a deleted job's reason takes one.
   */
  language?: string;
}

export function readHolidayState(db: Db = getDb()): HolidayState {
  const settings = readSettings(db);
  const cached = listCachedHolidays(db);
  const check = readHolidayCheck(db);
  const municipality = findMunicipality(settings.holidaysMunicipality);

  return {
    enabled: settings.holidaysEnabled,
    municipality: settings.holidaysMunicipality,
    municipalityName:
      municipality === undefined
        ? ''
        : `${municipality.name} (${ANDALUSIAN_PROVINCES[municipality.provinceIne] ?? ''})`.replace(
            ' ()',
            '',
          ),
    count: cached.length,
    knownThrough: cached.length === 0 ? null : cached[cached.length - 1].date,
    lastCheckedAt: check?.checkedAt ?? null,
    lastCheckSucceeded: check?.succeeded ?? false,
  };
}

/**
 * One pass. Fetching happens outside the transaction — it is slow and it is allowed to fail — and
 * everything that touches the calendar happens inside one.
 */
export async function runHolidayCheck(
  options: HolidayCheckOptions = {},
  db: Db = getDb(),
): Promise<HolidayCheckResult> {
  const today = options.today ?? todayLocal();
  const now = options.now ?? new Date();
  const source = options.source ?? HTTP_SOURCE;
  const settings = readSettings(db);

  if (!settings.holidaysEnabled) return skip('disabled', db);

  const previousCheck = readHolidayCheck(db);
  const municipalityChanged =
    previousCheck !== undefined && previousCheck.municipality !== settings.holidaysMunicipality;
  if (options.force !== true && !municipalityChanged && !isDue(previousCheck?.checkedAt, now)) {
    return skip('not-due', db);
  }

  const ine = settings.holidaysMunicipality;
  const payload = await source.dates();
  const dates = holidaysForMunicipality(payload, ine);
  if (dates === null) {
    // The cache is left exactly as it is: what we knew yesterday is better than nothing, and a
    // partial list would close some days and leave others open with no way to tell which.
    recordHolidayCheck({ municipality: ine, checkedAt: now.toISOString(), succeeded: false }, db);
    return skip('offline', db);
  }

  const names = await namesFor(source, ine, yearsOf(dates));
  const holidays = composeHolidays(dates, names, options.language);

  return runTransaction(db, () => {
    // BEFORE anything replaces it: the cache is the only record of what the app wrote where.
    const owned = new Map(listCachedHolidays(db).map((holiday) => [holiday.date, holiday.name]));
    const wanted = new Map(holidays.map((holiday) => [holiday.date, holiday]));

    const result: HolidayCheckResult = {
      closed: [],
      renamed: [],
      reopened: [],
      pending: [],
      refused: [],
      state: readHolidayState(db),
    };

    // Retired first, so a holiday that MOVED frees its old day before the new one is written.
    for (const [date, name] of owned) {
      if (wanted.has(date) || compareDates(date, today) < 0) continue;
      if (!stillOwnedByTheApp(date, name, db)) continue;
      reopenDays({ from: date, to: date, today }, db);
      result.reopened.push(date);
    }

    for (const holiday of holidays) {
      if (compareDates(holiday.date, today) < 0) continue;
      const stored = findDayOverride(holiday.date, db);

      if (stored !== undefined) {
        // Only a day the app still owns may be corrected, and only its NAME.
        if (stillOwnedByTheApp(holiday.date, owned.get(holiday.date), db) && stored.note !== holiday.name) {
          renameDay(holiday.date, holiday.name, db);
          result.renamed.push(holiday.date);
        }
        continue;
      }

      const rows = workByDay([holiday.date], db)[0]?.rows ?? [];
      if (rows.length > 0) {
        result.pending.push({ date: holiday.date, name: holiday.name, rows });
        continue;
      }

      const refusal = closeHoliday(holiday.date, holiday.name, [], today, db);
      if (refusal === null) result.closed.push(holiday.date);
      else result.refused.push({ date: holiday.date, name: holiday.name, code: refusal });
    }

    replaceCachedHolidays(holidays, db);
    recordHolidayCheck({ municipality: ine, checkedAt: now.toISOString(), succeeded: true }, db);
    result.state = readHolidayState(db);
    return result;
  });
}

/**
 * The panel's answers. `keep` padlocks the day's work and closes the day around it; `false` closes it
 * and lets the reflow carry the work forward.
 */
export function applyHolidayAnswers(
  answers: ReadonlyArray<{ date: string; keep: boolean }>,
  options: { today?: string } = {},
  db: Db = getDb(),
): HolidayCheckResult {
  const today = options.today ?? todayLocal();

  return runTransaction(db, () => {
    const cached = new Map(listCachedHolidays(db).map((holiday) => [holiday.date, holiday.name]));
    const result: HolidayCheckResult = {
      closed: [],
      renamed: [],
      reopened: [],
      pending: [],
      refused: [],
      state: readHolidayState(db),
    };

    for (const answer of answers) {
      const name = cached.get(answer.date);
      if (name === undefined || compareDates(answer.date, today) < 0) continue;
      if (findDayOverride(answer.date, db) !== undefined) continue;

      const refusal = closeHoliday(answer.date, name, answer.keep ? [answer.date] : [], today, db);
      if (refusal === null) result.closed.push(answer.date);
      else result.refused.push({ date: answer.date, name, code: refusal });
    }

    result.state = readHolidayState(db);
    return result;
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * One day, through the write every other absence goes through. A refusal is CAUGHT and returned: a
 * horizon the hours no longer fit in on the 8th of December must not cost the other thirteen days.
 */
function closeHoliday(
  date: string,
  name: string,
  keepWork: readonly string[],
  today: string,
  db: Db,
): string | null {
  try {
    saveAbsence({ kind: 'closed-days', from: date, to: date, reason: name, keepWork, today }, db);
    return null;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
}

/**
 * Whether this day is still the app's to touch: it is closed, and its note is EXACTLY what the last
 * check wrote there. Anything else — a note the owner rewrote, a day they closed themselves, a day
 * with no row at all — is theirs, and the app never writes on it again.
 */
function stillOwnedByTheApp(date: string, cachedName: string | undefined, db: Db): boolean {
  if (cachedName === undefined) return false;
  const stored = findDayOverride(date, db);
  return stored !== undefined && stored.isClosed && stored.note === cachedName;
}

/**
 * A rename EDITS the day: one write of the note, no reflow, no preview, `is_closed` and
 * `capacity_hours` untouched. Reopening and rewriting would land on the same date looking identical
 * while, in between, releasing the day, shuffling the queue and asking again about work whose
 * displace-or-keep answer was already given.
 */
function renameDay(date: string, name: string, db: Db): void {
  const stored = findDayOverride(date, db);
  if (stored === undefined) return;
  upsertDayOverride({ ...stored, note: name }, db);
}

/** Elapsed time and not a schedule: nothing runs while the app is closed, so a fortnight owes one. */
function isDue(checkedAt: string | undefined, now: Date): boolean {
  if (checkedAt === undefined) return true;
  const last = Date.parse(checkedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= CHECK_EVERY_DAYS * MS_PER_DAY;
}

function yearsOf(dates: readonly { date: string }[]): number[] {
  return [...new Set(dates.map((holiday) => Number(holiday.date.slice(0, 4))))].sort();
}

/**
 * The names, one request per year the dates reach. A year festivos.io has not published yet answers
 * nothing and the day keeps its fallback name — the normal first state for a local holiday.
 */
async function namesFor(
  source: HolidaySource,
  ine: string,
  years: readonly number[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const year of years) {
    const payload = await source.names(ine, year);
    for (const [date, name] of parseFestivosIo(payload)) names.set(date, name);
  }
  return names;
}

function skip(reason: 'disabled' | 'not-due' | 'offline', db: Db): HolidayCheckResult {
  return {
    skipped: reason,
    closed: [],
    renamed: [],
    reopened: [],
    pending: [],
    refused: [],
    state: readHolidayState(db),
  };
}
