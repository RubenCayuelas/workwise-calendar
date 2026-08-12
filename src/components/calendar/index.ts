/**
 * The week view. One import site:
 *
 *     import { CalendarScreen } from '@/src/components/calendar';
 *
 * `CalendarScreen` is the whole screen — header, summary strip, grid, gestures and the
 * data behind them. The job panel, the job form and the gap form are NOT part of it;
 * they arrive through the three `render*` props, which is the only wiring the page does.
 *
 * The pure modules are exported too, because they are the parts worth testing and
 * reusing: `geometry` (minutes <-> pixels, pointer -> slot), `grouping` (the rows of a
 * job drawn as one unit, and lanes for hand-made overlaps) and `dropEffect` (what the
 * drop under the pointer will do to the row it lands on).
 */

export {
  CalendarScreen,
  type CalendarScreenProps,
  type GapFormContext,
  type JobPanelContext,
  type NewJobContext,
} from './CalendarScreen';

export { SummaryStrip, type SummaryStripProps } from './SummaryStrip';
export { WeekHeader, type WeekHeaderProps } from './WeekHeader';
export { WeekGrid, type PlacingFragment, type SettleRequest, type WeekGridProps } from './WeekGrid';
export { CalendarBlock, type CalendarBlockProps } from './CalendarBlock';
export { SplitBlockDialog, MIN_SPLITTABLE_MINUTES, type SplitBlockDialogProps } from './SplitBlockDialog';

export { useWeek, type WeekController } from './useWeek';
export {
  useBlockDrag,
  type BlockDragOptions,
  type DragController,
  type DragKind,
  type DragPreview,
  type DragTarget,
} from './useBlockDrag';

export {
  DEFAULT_PIXELS_PER_HOUR,
  MIN_LABEL_HEIGHT,
  SNAP_MINUTES,
  axisTicks,
  columnOf,
  createTimeline,
  dateAtX,
  maxDurationFrom,
  nonWorkingBands,
  rankFor,
  slotAt,
  snapTo,
  type AxisTick,
  type BandKind,
  type ColumnBox,
  type GridMetrics,
  type SlotHit,
  type Timeline,
  type TimelineBand,
  type TimelineOptions,
} from './geometry';

export {
  assignLanes,
  groupBlocks,
  packDay,
  segmentsOf,
  workingMinutesBetween,
  type BlockGroup,
  type BlockSegment,
  type LaneItem,
  type LanePlacement,
} from './grouping';

export {
  dropEffectOf,
  type DropEffect,
  type DropEffectInput,
  type DropEffectKind,
  type DropRow,
} from './dropEffect';
