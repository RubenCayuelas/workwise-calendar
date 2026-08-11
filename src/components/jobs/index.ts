/**
 * The job side panel, the create-job flow and the two small forms next to them.
 *
 *     import { JobPanel, NewJobPanel, SplitBlockPanel, GapPanel } from '@/src/components/jobs';
 *
 * All four are `SidePanel`s, which is deliberate: the scaffold's panel has no scrim
 * ("the panel exists to edit something that is on the calendar, and the owner needs to
 * keep seeing the calendar while doing it"), and that is exactly right for a form whose
 * effect is a reflow of the grid behind it. They all live in the same slot on the right,
 * so RENDER AT MOST ONE AT A TIME.
 *
 * Three rules they all follow, from the API layer's notes:
 * - Every successful write reports `JobsMutationEvent`, and the parent MUST refetch the
 *   week — a recomposition rewrites rows in weeks the response never mentions.
 * - `touchedLockedBlockIds` is surfaced, never swallowed.
 * - A failure is never a sentence built here: `apiErrorMessage(error, t, language)`.
 *
 * None of them contains a scheduling decision. Where hours go is the engine's answer;
 * `describePlacement` only diffs the rows before a write against the rows after it, so
 * the panel can say where they actually went.
 */

export { JobPanel, type JobPanelProps } from './JobPanel';
export { NewJobPanel, type NewJobPanelProps } from './NewJobPanel';
export { SplitBlockPanel, type SplitBlockPanelProps, type SplitResult } from './SplitBlockPanel';
export { GapPanel, type GapPanelProps } from './GapPanel';

// The parts, for a screen that wants the pieces rather than the panel.
export {
  JobFields,
  jobFieldErrors,
  MAX_JOB_HOURS,
  MIN_JOB_HOURS,
  type JobFieldErrors,
  type JobFieldName,
  type JobFieldsProps,
  type JobFormValues,
} from './JobFields';
export { BlockRows, type BlockRowsProps } from './BlockRows';
export { PlacementNotice, type PlacementNoticeProps } from './PlacementNotice';

export {
  describePlacement,
  otherGapConflicts,
  placementHighlights,
  readGapConflicts,
  sumMinutes,
  type GapConflictInfo,
  type PlacementChange,
  type PlacementKind,
  type PlacementOutcome,
} from './placement';

/** The summary strip's sentence. The week header renders the same one — reuse this. */
export { scheduleSummaryMessage, type SummaryFormatter } from './summary';

export { HOUR_STEP, parseClockTime } from './forms';

export type { JobsMutationEvent, JobsMutationHandler, JobsMutationKind } from './events';
