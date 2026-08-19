/** The chosen start date as DATA: `notes` are KINDS, and the panel translates each one. */

import type { CreationPreview, CreationPreviewRow } from '../../lib/api-client';

/** One thing worth saying about the chosen date, in the order they are said. */
export type StartDateNote =
  /** The date is in the past: the rows are a record of work that was done. */
  | 'past'
  /** Saturday or Sunday — outside the engine, so the drop is the owner's word. */
  | 'weekend'
  /** Friday: the colchón, which the engine keeps for the growth of placed work. */
  | 'buffer'
  /** A holiday or a closed week: the day has no hours at all. */
  | 'closed'
  /** The queue already runs past that day, so the job starts later. */
  | 'deferred'
  /** Forced: it goes on that day and what follows moves forward. */
  | 'forced'
  /** Beyond everything, so every row is locked or the reflow would pull it back. */
  | 'autoLock'
  /** Something in the way carries a padlock: it stands, and the job goes around it. */
  | 'lockedStands'
  /** Nothing is sitting across the span at all. */
  | 'clear'
  /** These days have nothing on them, if the owner would rather move the date. */
  | 'freeDays';

export interface StartDateCollisionLine {
  /** `date|projectId` — stable across re-previews, so React keeps the row. */
  key: string;
  projectName: string;
  date: string;
  minutes: number;
  /** Forcing does not move it. The new job splits around it and continues after. */
  locked: boolean;
}

export interface StartDateSummary {
  /** `warning` whenever the answer is not simply "yes, that day". */
  tone: 'info' | 'warning';
  /** The day the hours really start on, `null` when nothing could be placed. */
  startsOn: string | null;
  endsOn: string | null;
  /** The rows to list, capped. */
  rows: CreationPreviewRow[];
  /** Rows beyond the cap, so the list can admit it is abridged. */
  moreRows: number;
  collisions: StartDateCollisionLine[];
  moreCollisions: number;
  /** Minutes already sitting across the whole span, summed. */
  collisionMinutes: number;
  /** How many jobs those minutes belong to. */
  collisionJobs: number;
  freeDates: string[];
  notes: StartDateNote[];
  /** The day is only honoured after an explicit confirmation. */
  needsConfirmation: boolean;
  confirmKind: 'buffer' | 'weekend' | null;
  /** Offer "place it that day anyway". */
  canForce: boolean;
  forced: boolean;
}

export interface StartDateLimits {
  /** Rows listed before the list is abridged. */
  rows?: number;
  collisions?: number;
  freeDates?: number;
}

const DEFAULT_LIMITS: Required<StartDateLimits> = { rows: 6, collisions: 6, freeDates: 5 };

/**
 * Turns a server preview into the lines the panel renders. Collisions are listed even when
 * the placement is DEFERRED and nothing will be displaced: knowing the span is taken is
 * what decides between forcing it, moving it and leaving it at the end of the queue.
 */
export function summarizeStartDate(
  preview: CreationPreview,
  limits: StartDateLimits = {},
): StartDateSummary {
  const caps = { ...DEFAULT_LIMITS, ...limits };

  const collisions: StartDateCollisionLine[] = preview.collisions.map((collision) => ({
    key: `${collision.date}|${collision.projectId}`,
    projectName: collision.projectName,
    date: collision.date,
    minutes: collision.minutes,
    locked: collision.locked,
  }));

  const jobs = new Set(preview.collisions.map((collision) => collision.projectId));
  const notes: StartDateNote[] = [];

  // The day itself first: it is the fact that decides everything below it.
  if (preview.day === 'past') notes.push('past');
  else if (preview.day === 'weekend') notes.push('weekend');
  else if (preview.day === 'buffer') notes.push('buffer');
  else if (preview.day === 'closed') notes.push('closed');

  if (preview.deferred) notes.push('deferred');
  if (preview.force && preview.mode === 'forced') notes.push('forced');
  // `past` already says the rows are created locked, and why, so `autoLock` would repeat it.
  if (preview.autoLock && preview.day !== 'past') notes.push('autoLock');

  if (collisions.length === 0) {
    if (preview.span !== null) notes.push('clear');
  } else if (collisions.some((collision) => collision.locked)) {
    notes.push('lockedStands');
  }

  // Only while the answer is unsatisfying: otherwise free days read as "change the date".
  const unsatisfied = preview.deferred || collisions.length > 0;
  if (unsatisfied && preview.freeDates.length > 0) notes.push('freeDays');

  return {
    tone: preview.deferred || collisions.length > 0 || preview.day !== 'auto' ? 'warning' : 'info',
    startsOn: preview.startsOn,
    endsOn: preview.endsOn,
    rows: preview.rows.slice(0, caps.rows),
    moreRows: Math.max(0, preview.rows.length - caps.rows),
    collisions: collisions.slice(0, caps.collisions),
    moreCollisions: Math.max(0, collisions.length - caps.collisions),
    collisionMinutes: preview.collisions.reduce((total, collision) => total + collision.minutes, 0),
    collisionJobs: jobs.size,
    freeDates: preview.freeDates.slice(0, caps.freeDates),
    notes,
    needsConfirmation: preview.needsDayConfirmation,
    confirmKind:
      preview.day === 'buffer' ? 'buffer' : preview.day === 'weekend' ? 'weekend' : null,
    canForce: preview.canForce,
    forced: preview.force && preview.mode === 'forced',
  };
}
