/**
 * The job side panel, the create-job flow and the two small forms next to them. All four
 * are `SidePanel`s sharing one slot on the right, so RENDER AT MOST ONE AT A TIME.
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
