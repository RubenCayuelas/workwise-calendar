/**
 * The week grid's arithmetic: minutes <-> pixels, and pointer position <-> a
 * (date, minute) slot.
 *
 * Everything the calendar draws or drops is decided here, and nothing here touches
 * React or the DOM — the drag layer measures the columns once and hands the numbers
 * over. That separation is the point: the grid is absolute positioning over a
 * timeline, so one wrong offset moves every block on screen, and a mistake in a pure
 * function is far easier to reason about than one tangled into a pointer handler.
 *
 * Two invariants of the codebase hold inside this file too:
 *
 * - Time is INTEGER MINUTES from midnight. Hours only appear in what the owner reads.
 * - A date is a local `YYYY-MM-DD` string, never derived here from a clock.
 */

import type { DayShape, WorkPeriod } from '../../types';

/**
 * The drop and resize increment. Quarters of an hour: the shop plans in halves, but
 * a quarter makes the drag feel like it follows the mouse instead of jumping.
 */
export const SNAP_MINUTES = 15;

/** A row shorter than this cannot show its own hours, only its name. */
export const MIN_LABEL_HEIGHT = 34;

/** Default vertical scale, used until the grid has been measured. */
export const DEFAULT_PIXELS_PER_HOUR = 72;

/**
 * Bounds for the fitted scale. The whole day should be visible without scrolling —
 * "see how long the workshop is booked" is the point of the screen — but not at the
 * price of a block too short to read or a day stretched over two screens.
 */
export const MIN_PIXELS_PER_HOUR = 42;
export const MAX_PIXELS_PER_HOUR = 96;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

/** The largest stretch of clock the axis labels without an interior tick. */
const MAX_UNLABELLED_HOURS = 3;

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

/** The vertical scale of the grid: one shared mapping for all seven columns. */
export interface Timeline {
  /** Top of the axis, in minutes from midnight. */
  readonly startMinutes: number;
  /** Bottom of the axis. */
  readonly endMinutes: number;
  readonly spanMinutes: number;
  readonly pixelsPerMinute: number;
  /** The height a day column must have, in pixels. */
  readonly height: number;
  /** Offset of a time from the top of a column. */
  yOf(minutes: number): number;
  /** A duration as a height. Never returns less than 1px, so nothing is invisible. */
  heightOf(durationMinutes: number): number;
  /** The time at an offset from the top of a column. Clamped to the axis. */
  minutesAt(y: number): number;
  /** Keeps a start time on the axis, leaving room for `durationMinutes`. */
  clampStart(minutes: number, durationMinutes?: number): number;
}

export interface TimelineOptions {
  pixelsPerHour?: number;
  /**
   * Times that must be visible even though Settings does not cover them — a block
   * placed by hand into a margin, or one left over from a longer working day. The
   * axis grows to the containing hour rather than clipping the block.
   */
  cover?: readonly number[];
  /**
   * Pixels available for the timeline. When given, the scale is chosen to fill it (within
   * `MIN_PIXELS_PER_HOUR`..`MAX_PIXELS_PER_HOUR`) instead of using `pixelsPerHour`, so the
   * whole day fits on screen on the shop's monitor and only scrolls when it truly cannot.
   */
  fitHeight?: number;
}

/**
 * The axis for a week, from `DayShape` (which already resolved the visual margins)
 * widened to cover anything the week actually holds.
 */
export function createTimeline(shape: DayShape, options: TimelineOptions = {}): Timeline {
  let startMinutes = clamp(shape.timelineStartMinutes, 0, MINUTES_PER_DAY);
  let endMinutes = clamp(shape.timelineEndMinutes, 0, MINUTES_PER_DAY);

  for (const minutes of options.cover ?? []) {
    if (!Number.isFinite(minutes)) continue;
    if (minutes < startMinutes) startMinutes = floorTo(clamp(minutes, 0, MINUTES_PER_DAY), MINUTES_PER_HOUR);
    if (minutes > endMinutes) endMinutes = ceilTo(clamp(minutes, 0, MINUTES_PER_DAY), MINUTES_PER_HOUR);
  }

  // A degenerate configuration (identical period times) would divide by zero.
  if (endMinutes <= startMinutes) endMinutes = Math.min(startMinutes + MINUTES_PER_HOUR, MINUTES_PER_DAY);

  const spanMinutes = endMinutes - startMinutes;
  const pixelsPerHour =
    options.fitHeight !== undefined && options.fitHeight > 0
      ? clamp(
          (options.fitHeight / spanMinutes) * MINUTES_PER_HOUR,
          MIN_PIXELS_PER_HOUR,
          MAX_PIXELS_PER_HOUR,
        )
      : (options.pixelsPerHour ?? DEFAULT_PIXELS_PER_HOUR);
  const pixelsPerMinute = pixelsPerHour / MINUTES_PER_HOUR;
  const height = Math.round(spanMinutes * pixelsPerMinute);

  return {
    startMinutes,
    endMinutes,
    spanMinutes,
    pixelsPerMinute,
    height,
    yOf: (minutes) => (clamp(minutes, startMinutes, endMinutes) - startMinutes) * pixelsPerMinute,
    heightOf: (durationMinutes) => Math.max(1, durationMinutes * pixelsPerMinute),
    minutesAt: (y) => clamp(Math.round(startMinutes + y / pixelsPerMinute), startMinutes, endMinutes),
    clampStart: (minutes, durationMinutes = 0) =>
      clamp(minutes, startMinutes, Math.max(startMinutes, endMinutes - durationMinutes)),
  };
}

// ---------------------------------------------------------------------------
// Bands: the grey stripes for the visual margins and the lunch break
// ---------------------------------------------------------------------------

export type BandKind = 'marginTop' | 'lunch' | 'marginBottom';

export interface TimelineBand {
  kind: BandKind;
  startMinutes: number;
  endMinutes: number;
}

/**
 * The non-working stretches inside the axis, as the complement of the day's periods.
 *
 * Derived rather than read from Settings so an axis widened by `cover` still paints
 * the whole non-working area grey: the rule the owner sees is "grey means the engine
 * will not put work here", and that is exactly "outside a period".
 */
export function nonWorkingBands(
  periods: readonly WorkPeriod[],
  timeline: Timeline,
): TimelineBand[] {
  const sorted = [...periods].sort((a, b) => a.startMinutes - b.startMinutes);
  const bands: TimelineBand[] = [];
  let cursor = timeline.startMinutes;

  for (const period of sorted) {
    const start = clamp(period.startMinutes, timeline.startMinutes, timeline.endMinutes);
    if (start > cursor) {
      bands.push({ kind: cursor === timeline.startMinutes ? 'marginTop' : 'lunch', startMinutes: cursor, endMinutes: start });
    }
    cursor = Math.max(cursor, clamp(period.endMinutes, timeline.startMinutes, timeline.endMinutes));
  }

  if (cursor < timeline.endMinutes) {
    bands.push({
      // A day with no periods at all (a closed day, or a broken configuration) is one
      // single band; calling it the bottom margin would be a lie, so it stays a top one.
      kind: sorted.length === 0 ? 'marginTop' : 'marginBottom',
      startMinutes: cursor,
      endMinutes: timeline.endMinutes,
    });
  }

  return bands;
}

/**
 * Where a day's "libre" / "—" label belongs: the middle of the day's LONGEST WORKING
 * STRETCH.
 *
 * Not the middle of the column, which is what it used to be and which is a trap with the
 * documented shift: 07:00 to 20:30 has its midpoint at 13:45, fifteen minutes above the
 * 14:00 rule and right on the edge of the grey lunch band. The word landed on a line
 * instead of in the day and read as debris left over from something else.
 *
 * The longest period is the part of the column that IS the working day, and its middle
 * is strictly inside a period — never on a boundary, never inside a band — for every
 * shift the settings can produce. A day with no periods at all (a closed day, or a
 * broken configuration) has no working stretch to sit in, so it falls back to the middle
 * of the axis, which is then the middle of one uninterrupted grey band.
 */
export function emptyLabelMinutes(periods: readonly WorkPeriod[], timeline: Timeline): number {
  let longest: WorkPeriod | undefined;
  for (const period of periods) {
    const span = period.endMinutes - period.startMinutes;
    if (span <= 0) continue;
    if (longest === undefined || span > longest.endMinutes - longest.startMinutes) longest = period;
  }

  const middle =
    longest === undefined
      ? (timeline.startMinutes + timeline.endMinutes) / 2
      : (longest.startMinutes + longest.endMinutes) / 2;
  return clamp(middle, timeline.startMinutes, timeline.endMinutes);
}

// ---------------------------------------------------------------------------
// The time axis
// ---------------------------------------------------------------------------

export interface AxisTick {
  minutes: number;
  /** A period edge or an end of the axis: labelled and drawn stronger. */
  boundary: boolean;
}

/**
 * The times the axis labels: every edge of the day plus enough interior ticks that
 * no stretch of clock runs more than three hours without one.
 *
 * That rule is what reproduces the wireframe exactly — a 6h morning gets 11:00 and a
 * 4h afternoon gets 17:30 — while still behaving on a 12h single period.
 */
export function axisTicks(periods: readonly WorkPeriod[], timeline: Timeline): AxisTick[] {
  const ticks = new Map<number, AxisTick>();
  const add = (minutes: number, boundary: boolean): void => {
    if (minutes < timeline.startMinutes || minutes > timeline.endMinutes) return;
    const existing = ticks.get(minutes);
    if (existing === undefined) ticks.set(minutes, { minutes, boundary });
    else if (boundary) existing.boundary = true;
  };

  add(timeline.startMinutes, true);
  add(timeline.endMinutes, true);

  for (const period of periods) {
    add(period.startMinutes, true);
    add(period.endMinutes, true);

    const span = period.endMinutes - period.startMinutes;
    const segments = Math.max(1, Math.ceil(span / (MAX_UNLABELLED_HOURS * MINUTES_PER_HOUR)));
    for (let index = 1; index < segments; index += 1) {
      // Snapped to the half hour: an axis reading 10:24 would look like a bug.
      add(roundTo(period.startMinutes + (span * index) / segments, 30), false);
    }
  }

  return [...ticks.values()].sort((a, b) => a.minutes - b.minutes);
}

// ---------------------------------------------------------------------------
// Pointer position -> a slot on the calendar
// ---------------------------------------------------------------------------

/** One measured day column, in client (viewport) coordinates. */
export interface ColumnBox {
  date: string;
  left: number;
  width: number;
}

/** What the drag layer measures before it can translate a pointer position. */
export interface GridMetrics {
  /** Client Y of the top of the timeline — the same for all seven columns. */
  top: number;
  columns: ColumnBox[];
}

/** The column under `x`, or `undefined` when the pointer is outside the grid. */
export function dateAtX(x: number, columns: readonly ColumnBox[]): string | undefined {
  for (const column of columns) {
    if (x >= column.left && x < column.left + column.width) return column.date;
  }
  return undefined;
}

export function columnOf(date: string, columns: readonly ColumnBox[]): ColumnBox | undefined {
  return columns.find((column) => column.date === date);
}

export interface SlotHit {
  date: string;
  /** The minute the pointer is actually over, unsnapped. Decides which way a tie breaks. */
  exactMinutes: number;
  /** The minute a drop would use. */
  snappedMinutes: number;
}

/**
 * The (date, minute) the pointer is over. `undefined` only when the pointer has left
 * the grid horizontally; vertically it clamps, so a drag towards the window edge
 * still tracks the first and last minute of the day.
 */
export function slotAt(
  point: { x: number; y: number },
  metrics: GridMetrics,
  timeline: Timeline,
  snap: number = SNAP_MINUTES,
): SlotHit | undefined {
  const date = dateAtX(point.x, metrics.columns);
  if (date === undefined) return undefined;

  const exactMinutes = timeline.minutesAt(point.y - metrics.top);
  return { date, exactMinutes, snappedMinutes: snapTo(exactMinutes, snap) };
}

export function snapTo(minutes: number, snap: number = SNAP_MINUTES): number {
  return Math.round(minutes / snap) * snap;
}

/**
 * The queue rank a drop should write.
 *
 * A block's (date, start) IS its place in the queue, and the order is total: ties are
 * broken by `created_at` then `id`, so a drop landing exactly on an existing block's
 * start silently loses to the older row and the drag appears to have done nothing.
 * The fix is to rank strictly between neighbours, and the direction comes from the
 * unsnapped pointer position: above the tie means "before it", below means "after".
 *
 * One minute is enough — the rank is an ordering, not a time, and the reflow rewrites
 * the position anyway.
 */
export function rankFor(
  snappedMinutes: number,
  exactMinutes: number,
  takenStarts: readonly number[],
  timeline: Timeline,
  durationMinutes = 0,
): number {
  if (!takenStarts.includes(snappedMinutes)) return snappedMinutes;
  const direction = exactMinutes < snappedMinutes ? -1 : 1;
  const nudged = timeline.clampStart(snappedMinutes + direction, durationMinutes);
  // Clamping may have pushed it back onto the tie (a drop on the very first minute of
  // the axis); the other direction is then the only one left.
  if (nudged !== snappedMinutes) return nudged;
  return timeline.clampStart(snappedMinutes - direction, durationMinutes);
}

// ---------------------------------------------------------------------------
// Resizing
// ---------------------------------------------------------------------------

/**
 * The longest a block starting at `startMinutes` may be.
 *
 * "A stored block never straddles a non-working interval", so a row stops at the end
 * of the period it lives in. A row that starts in a margin (dropped there by hand)
 * stops at the next period's start instead, which is the same rule read the other way.
 */
export function maxDurationFrom(
  startMinutes: number,
  periods: readonly WorkPeriod[],
  timeline: Timeline,
): number {
  let limit = timeline.endMinutes;

  for (const period of periods) {
    if (startMinutes >= period.startMinutes && startMinutes < period.endMinutes) {
      limit = period.endMinutes;
      break;
    }
    if (period.startMinutes > startMinutes && period.startMinutes < limit) limit = period.startMinutes;
  }

  return Math.max(SNAP_MINUTES, limit - startMinutes);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function floorTo(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function ceilTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}
