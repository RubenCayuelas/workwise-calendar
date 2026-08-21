import { getDb, type Db } from '../db';
import { todayLocal } from '../dates';
import { redoNext, undoLast, type HistoryOutcome } from '../history';
import { readSummary } from '../scheduler';
import type { ScheduleSummary } from '../composition';

export interface HistoryMutation extends HistoryOutcome {
  summary: ScheduleSummary;
}

/**
 * Walking the line is not a gesture and asks none of their questions: it restores rows the
 * calendar already held, so the frozen past, the padlock and the day's shape have nothing to
 * refuse. `changed: false` is the ordinary answer to "there is nothing there", never a 409 —
 * a grey button that raced a keystroke must not raise an error banner.
 */
export function undoChange(options: { today?: string } = {}, db: Db = getDb()): HistoryMutation {
  return withSummary(undoLast(db), options.today ?? todayLocal(), db);
}

export function redoChange(options: { today?: string } = {}, db: Db = getDb()): HistoryMutation {
  return withSummary(redoNext(db), options.today ?? todayLocal(), db);
}

function withSummary(outcome: HistoryOutcome, today: string, db: Db): HistoryMutation {
  return { ...outcome, summary: readSummary(db, today) };
}
