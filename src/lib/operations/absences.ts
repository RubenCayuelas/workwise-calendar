/**
 * An absence over a RANGE of days, in the two shapes the owner has: one gap repeated on every day of
 * it, or one CLOSED DAY each. The shop's own week — `2026-09-01` to `09-04`, "Fair" — was four gaps
 * typed by hand because this had no screen and no route, while `day_overrides` held nothing.
 *
 * ONE FUNCTION SERVES THE PREVIEW AND THE SAVE (`writeAbsence`): the preview runs the real write
 * inside a transaction it then rolls back, so the screen cannot promise a placement the save will not
 * perform, and a refusal — a padlocked row in the way, a horizon the hours no longer fit in — is
 * reported by the same code that would refuse the save.
 */

import { getDb, type Db } from '../db';
import { MINUTES_PER_DAY, compareDates, daysBetween, minutesToHHmm, todayLocal } from '../dates';
import { absenceRange, MAX_ABSENCE_DAYS } from '../absences';
import { findGapConflicts, type GapConflict, type ScheduleSummary } from '../composition';
import { badRequest, conflict, ERROR_MESSAGE_KEYS } from '../errors';
import { withHistory } from '../history';
import { readSummary, recompose } from '../scheduler';
import { listBlocks } from '../repositories/blocks';
import {
  deleteDayOverride,
  findDayOverride,
  upsertDayOverride,
} from '../repositories/dayOverrides';
import { listProjects } from '../repositories/projects';
import { insertAbsence } from './gaps';
import type { Block, DayOverride, Gap } from '../../types';

/** `gap` repeats one absence on every day of the range; `closed-days` writes an override each. */
export type AbsenceKind = 'gap' | 'closed-days';

export const ABSENCE_KINDS: readonly AbsenceKind[] = ['gap', 'closed-days'];

export interface AbsenceInput {
  kind: AbsenceKind;
  from: string;
  /** Absent means a range of one day. */
  to?: string;
  /**
   * The absence's own words. Stored as the gap's `reason`, or as the closed day's `note` — which is
   * what the day header prints.
   */
  reason?: string;
  /** `gap` only, and required there. Net working minutes, cut at the lunch break on the way in. */
  startMinutes?: number;
  durationMinutes?: number;
  today?: string;
}

/** A job the write pushed forward, and where its hours ended up. */
export interface DisplacedWork {
  projectId: string;
  name: string;
  /** Minutes of this job that left the day they were on. */
  minutes: number;
  /** The last day the job occupies afterwards: where its hours now reach. */
  landsOn: string;
}

export interface AbsenceMutation {
  kind: AbsenceKind;
  /** The days written to, in calendar order. */
  dates: string[];
  /** Weekend days the range dropped. */
  skippedDates: string[];
  /** `gap` only: every row written, over every day. */
  gaps: Gap[];
  /** `closed-days` only: the overrides as stored. */
  days: DayOverride[];
  displaced: DisplacedWork[];
  summary: ScheduleSummary;
}

/** One row of an absence as the preview reports it: geometry only, because it has no id. */
export interface AbsencePreviewRow {
  date: string;
  startMinutes: number;
  durationMinutes: number;
}

/**
 * What the save WOULD do. Nothing here carries an id: every row the dry run wrote was rolled back, so
 * an id from it would name a row that will never exist.
 */
export interface AbsencePreview {
  today: string;
  kind: AbsenceKind;
  dates: string[];
  skippedDates: string[];
  /** `gap` only: the rows each day would hold, cut at the lunch break. */
  rows: AbsencePreviewRow[];
  /** Days of the range that are already closed, so the screen offers to reopen them. */
  alreadyClosedDates: string[];
  displaced: DisplacedWork[];
  /** The calendar's furthest day before and after, which is the range's cost in one number. */
  lastOccupiedBefore: string | null;
  lastOccupiedAfter: string | null;
}

/** Writes it, in ONE transaction: the rows, the reflow they displace and nothing half done. */
export function saveAbsence(input: AbsenceInput, db: Db = getDb()): AbsenceMutation {
  const today = input.today ?? todayLocal();
  const kind = input.kind === 'closed-days' ? 'absence.closeDays' : 'absence.gaps';
  return withHistory(db, { kind }, () => writeAbsence(input, today, db));
}

/**
 * The same write, rolled back. Every refusal the save would make is thrown from here too — that is
 * the point of running the real thing rather than a model of it.
 */
export function previewAbsence(input: AbsenceInput, db: Db = getDb()): AbsencePreview {
  const today = input.today ?? todayLocal();
  const before = readSummary(db, today).lastOccupiedDate;
  const closed = new Set<string>();

  const mutation = dryRun(db, () => {
    for (const date of resolveRange(input).dates) {
      if (findDayOverride(date, db)?.isClosed === true) closed.add(date);
    }
    return writeAbsence(input, today, db);
  });

  return {
    today,
    kind: mutation.kind,
    dates: mutation.dates,
    skippedDates: mutation.skippedDates,
    rows: mutation.gaps.map((gap) => ({
      date: gap.date,
      startMinutes: gap.startMinutes,
      durationMinutes: gap.durationMinutes,
    })),
    alreadyClosedDates: mutation.dates.filter((date) => closed.has(date)),
    displaced: mutation.displaced,
    lastOccupiedBefore: before,
    lastOccupiedAfter: mutation.summary.lastOccupiedDate,
  };
}

/**
 * Reopens every closed day in the range and lets the queue fill them again. The ROW is dropped, note
 * and all, except where it also carries a hand-entered `capacity_hours` — the one thing here that no
 * screen can put back — and then only `is_closed` is cleared.
 */
export function reopenDays(
  input: { from: string; to?: string; today?: string },
  db: Db = getDb(),
): { dates: string[]; summary: ScheduleSummary } {
  const today = input.today ?? todayLocal();
  const range = resolveRange({ from: input.from, to: input.to });

  return withHistory(db, { kind: 'absence.reopen' }, () => {
    const dates: string[] = [];
    for (const date of range.dates) {
      const stored = findDayOverride(date, db);
      if (stored === undefined || !stored.isClosed) continue;
      if (stored.capacityHours === null) deleteDayOverride(date, db);
      else upsertDayOverride({ ...stored, isClosed: false }, db);
      dates.push(date);
    }
    const report = recompose(db, { today });
    return { dates, summary: report.summary };
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The write both entry points run. Inside a transaction already, so every refusal below rolls the
 * whole range back — including `horizon-exceeded` from the reflow, which is what kept a closed week
 * that no longer fit on disk and made every later write fail with it.
 */
function writeAbsence(input: AbsenceInput, today: string, db: Db): AbsenceMutation {
  const range = resolveRange(input);
  const before = listBlocks(db);

  const gaps: Gap[] = [];
  const days: DayOverride[] = [];

  if (input.kind === 'gap') {
    const startMinutes = input.startMinutes;
    const durationMinutes = input.durationMinutes;
    if (startMinutes === undefined || durationMinutes === undefined) {
      throw badRequest('invalid-payload', ERROR_MESSAGE_KEYS.invalidPayload, {
        field: startMinutes === undefined ? 'startMinutes' : 'durationMinutes',
      });
    }
    for (const date of range.dates) {
      // Every day of the range is refused or written on its own terms, and the whole range is one
      // transaction: a padlocked row on the Wednesday takes the Monday's absence with it.
      gaps.push(...insertAbsence({ date, startMinutes, durationMinutes, reason: input.reason }, today, db));
    }
  } else {
    for (const date of range.dates) {
      assertDayCanClose(date, today, db);
      const stored = findDayOverride(date, db);
      days.push(
        upsertDayOverride(
          {
            date,
            isClosed: true,
            // Carried, never overwritten: the upsert writes all four columns, and a day with a
            // hand-entered capacity would come back with it silently blanked.
            capacityHours: stored?.capacityHours ?? null,
            note: input.reason,
          },
          db,
        ),
      );
    }
  }

  const report = recompose(db, { today });
  return {
    kind: input.kind,
    dates: range.dates,
    skippedDates: range.skipped,
    gaps,
    days,
    displaced: displacedWork(before, report.blocks, today, db),
    summary: report.summary,
  };
}

/** The range, refusing what the screen's two pickers can still express. */
function resolveRange(input: { from: string; to?: string }): { dates: string[]; skipped: string[] } {
  const to = input.to ?? input.from;
  if (compareDates(to, input.from) < 0) {
    // Its own sentence: the shared one names a day limit, and this path has no limit to name — the
    // owner was shown a raw `{{maxDays}}`.
    throw badRequest('range-backwards', ERROR_MESSAGE_KEYS.rangeBackwards, {
      field: 'to',
      details: { from: input.from, to },
    });
  }
  if (daysBetween(input.from, to) + 1 > MAX_ABSENCE_DAYS) {
    throw badRequest('invalid-range', ERROR_MESSAGE_KEYS.invalidRange, {
      field: 'to',
      details: { from: input.from, to, maxDays: MAX_ABSENCE_DAYS },
    });
  }
  return absenceRange(input.from, to);
}

/** A closed day's own sentences: the same three reasons, about the DAY rather than about a gap. */
const CONFLICT_KEYS: Record<GapConflict['reason'], string> = {
  locked: ERROR_MESSAGE_KEYS.closedDayOverLockedBlock,
  past: ERROR_MESSAGE_KEYS.closedDayOverPastBlock,
  weekend: ERROR_MESSAGE_KEYS.closedDayOverWeekendBlock,
};

/**
 * A day the engine cannot empty may not be closed. Same question a gap asks over its own footprint,
 * asked over the WHOLE day, and refused with the same three sentences: the alternative is a day that
 * says "closed" while work nothing will move sits on it, reporting no capacity at all.
 */
function assertDayCanClose(date: string, today: string, db: Db): void {
  const conflicts = findGapConflicts(
    listBlocks(db),
    { date, startMinutes: 0, durationMinutes: MINUTES_PER_DAY },
    today,
  );
  if (conflicts.length === 0) return;

  const names = new Map(listProjects(db).map((project) => [project.id, project.name]));
  const headline = conflicts.find((item) => item.reason === 'locked') ?? conflicts[0];
  throw conflict('closed-day-over-fixed-block', CONFLICT_KEYS[headline.reason], {
    details: {
      projectName: names.get(headline.projectId) ?? '',
      date: headline.date,
      startTime: minutesToHHmm(headline.startMinutes),
      endTime: minutesToHHmm(headline.startMinutes + headline.durationMinutes),
      reason: headline.reason,
      conflicts: conflicts.map((item) => ({
        ...item,
        projectName: names.get(item.projectId) ?? '',
      })),
    },
  });
}

/**
 * Which jobs the reflow pushed and where their hours ended up. Read from the rows before and after
 * the write rather than predicted: only a whole pass knows, and this is the one number the owner is
 * being asked to accept before a bulk save.
 */
function displacedWork(
  before: readonly Block[],
  after: readonly Block[],
  today: string,
  db: Db,
): DisplacedWork[] {
  const names = new Map(listProjects(db).map((project) => [project.id, project.name]));
  const now = minutesByDay(after);
  const displaced: DisplacedWork[] = [];

  for (const [projectId, wasOn] of minutesByDay(before)) {
    const isOn = now.get(projectId) ?? new Map<string, number>();
    let minutes = 0;
    for (const [date, was] of wasOn) {
      if (compareDates(date, today) < 0) continue;
      minutes += Math.max(0, was - (isOn.get(date) ?? 0));
    }
    if (minutes === 0) continue;
    const landsOn = lastDateOf(after, projectId);
    if (landsOn === null) continue;
    displaced.push({ projectId, name: names.get(projectId) ?? '', minutes, landsOn });
  }

  return displaced.sort(
    (a, b) => compareDates(a.landsOn, b.landsOn) || a.name.localeCompare(b.name),
  );
}

function minutesByDay(blocks: readonly Block[]): Map<string, Map<string, number>> {
  const byProject = new Map<string, Map<string, number>>();
  for (const block of blocks) {
    let byDate = byProject.get(block.projectId);
    if (byDate === undefined) {
      byDate = new Map<string, number>();
      byProject.set(block.projectId, byDate);
    }
    byDate.set(block.date, (byDate.get(block.date) ?? 0) + block.durationMinutes);
  }
  return byProject;
}

function lastDateOf(blocks: readonly Block[], projectId: string): string | null {
  let last: string | null = null;
  for (const block of blocks) {
    if (block.projectId !== projectId) continue;
    if (last === null || compareDates(block.date, last) > 0) last = block.date;
  }
  return last;
}

/** Carries the dry run's result out through the throw that rolls its transaction back. */
class Rollback extends Error {
  constructor(readonly value: unknown) {
    super('absence preview rolled back');
  }
}

/**
 * Runs `work` for real and undoes it. The only honest way to answer "what would this do to the
 * calendar": the reflow's answer is not derivable from the rows without running it.
 */
function dryRun<T>(db: Db, work: () => T): T {
  try {
    db.transaction(() => {
      throw new Rollback(work());
    })();
  } catch (error) {
    if (error instanceof Rollback) return error.value as T;
    throw error;
  }
  throw new Error('unreachable: the dry run always throws');
}
