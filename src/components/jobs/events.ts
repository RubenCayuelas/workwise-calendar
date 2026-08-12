/**
 * The one event every panel in this folder reports when it has written something.
 *
 * There is exactly one type on purpose: the calendar wires a single
 * `onChanged={reloadWeek}` and is done, because the rule from the API layer is
 * absolute — "After any mutation, REFETCH /api/week. A recomposition can rewrite rows
 * in any week, so mutation responses deliberately return only the touched entity plus
 * the summary." The `summary` here is that fresh strip, so the header can update
 * without waiting for the refetch.
 */

import type { ScheduleSummary } from '../../lib/api-client';

export type JobsMutationKind =
  | 'job-created'
  | 'job-updated'
  | 'job-deleted'
  | 'block-locked'
  /** A hand-set length was given back to the engine ("back to automatic"). */
  | 'block-released'
  | 'block-split'
  | 'gap-created'
  | 'gap-updated'
  | 'gap-deleted';

export interface JobsMutationEvent {
  kind: JobsMutationKind;
  /** The job involved, when the write was about one. */
  projectId?: string;
  /** The row the gesture named. For a split, the row that was CUT, not the fragment. */
  blockId?: string;
  gapId?: string;
  /** The schedule strip as of this write. Week-independent, like `GET /api/summary`. */
  summary: ScheduleSummary;
}

/** Callback shape shared by every panel here. */
export type JobsMutationHandler = (event: JobsMutationEvent) => void;
