/**
 * Minutes <-> pixels, and pointer position <-> a (date, minute) slot. Time is integer minutes from
 * midnight; a date is a local `YYYY-MM-DD` string.
 */

import {
  clockEndOf,
  dayEndMinutes,
  latestStartFor,
  netMinutesBetween,
  netMinutesOf,
  reachableRuns,
} from '../../lib/manualWindow';
import type { DayShape, WorkPeriod } from '../../types';

/**
 * Held equal to `MIN_ROW_MINUTES` and `TimeSelect`'s step. A quarter and not a half, though the shop
 * plans in halves: at 30 the drag jumps instead of following the mouse.
 */
export const SNAP_MINUTES = 15;

/** Below this a row shows its name but not its hours. */
export const MIN_LABEL_HEIGHT = 34;

/** Below this the bar and the resize handle meet, so the bar lifts off the row (`.detached`). */
export const MIN_ACTIONS_HEIGHT = 56;

/**
 * A row with less than this above it on the axis cannot dock the bar outside its TOP edge without
 * going under the sticky day header, so it docks below instead.
 */
export const ACTIONS_BAR_HEIGHT = 27;

/** One button: 24 px plus the 2 px gap between them. */
export const ACTIONS_BUTTON_WIDTH = 26;

export const MIN_BLOCK_GRAB_WIDTH = 44;

/**
 * `width` is the block's own width — a lane's share of the column, not the column. `null` is "not
 * measured yet" and answers `true`: one frame of the old placement beats one frame of a bar hanging
 * over the row above.
 */
export function blockHoldsActions(width: number | null, buttons: number): boolean {
  if (width === null) return true;
  return width - buttons * ACTIONS_BUTTON_WIDTH >= MIN_BLOCK_GRAB_WIDTH;
}

export const DEFAULT_PIXELS_PER_HOUR = 72;

/**
 * Bounds for the fitted scale. They bound WORKING time only — a break between two periods is drawn
 * at `BREAK_BAND_HEIGHT` whatever the scale.
 */
export const MIN_PIXELS_PER_HOUR = 42;
export const MAX_PIXELS_PER_HOUR = 96;

/**
 * The height of the break between two working periods whatever scale the rest of the axis is drawn
 * at. 28 px is the smallest band that still holds its own two edge labels (18 px line boxes). The
 * mapping stays an exact inverse inside it (~3.2 minutes to the pixel), which the drag layer needs.
 */
export const BREAK_BAND_HEIGHT = 28;

/** One axis label's own line box: `--ww-text-sm` at the page's line height. */
const TICK_LABEL_HEIGHT = 18;

const MIN_TICK_CLEARANCE = 2;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

// The timeline

/**
 * PIECEWISE: working time at `pixelsPerMinute`, a break between two periods squeezed into
 * `BREAK_BAND_HEIGHT`. So "how tall is 90 minutes" has no answer without saying WHERE.
 */
export interface Timeline {
  /** Top of the axis, in minutes from midnight. */
  readonly startMinutes: number;
  /** Bottom of the axis. */
  readonly endMinutes: number;
  /** The axis's span on the CLOCK, compressed break included. */
  readonly spanMinutes: number;
  /**
   * The scale of WORKING time — the one every block is drawn at. A compressed break is NOT on
   * this scale, so this may not be used to convert a span that contains one.
   */
  readonly pixelsPerMinute: number;
  /** The height a day column must have, in pixels. */
  readonly height: number;
  /** Offset of a time from the top of a column. Monotonic, and clamped to the axis. */
  yOf(minutes: number): number;
  /**
   * The pixels between two times on the clock, a compressed break included, never under 1px. For any
   * stored row it equals `duration * pixelsPerMinute` exactly, since no block straddles a break.
   */
  heightBetween(fromMinutes: number, toMinutes: number): number;
  /** The time at an offset from the top of a column. Clamped to the axis. */
  minutesAt(y: number): number;
  /** Keeps a start time on the axis, leaving room for `durationMinutes`. */
  clampStart(minutes: number, durationMinutes?: number): number;
}

/**
 * One stretch of the axis drawn at a single scale. An array rather than a formula because both
 * directions must agree exactly — each picks the LAST segment starting at or before its input, so a
 * value on a seam is converted with a zero offset and both return the stored number literally.
 */
interface AxisSegment {
  startMinutes: number;
  endMinutes: number;
  startY: number;
  pixelsPerMinute: number;
}

export interface TimelineOptions {
  pixelsPerHour?: number;
  /**
   * Times that must be visible even though Settings does not cover them — a block placed by hand into
   * a margin, or one left over from a longer working day. The axis grows to the containing hour.
   */
  cover?: readonly number[];
  /**
   * Pixels available for the timeline. When given, the scale is fitted to it (within
   * `MIN_PIXELS_PER_HOUR`..`MAX_PIXELS_PER_HOUR`) instead of using `pixelsPerHour`.
   */
  fitHeight?: number;
}

/**
 * The axis for a week, from `DayShape` widened to cover anything the week actually holds. The scale
 * is fitted over WORKING minutes only: each break costs a flat `BREAK_BAND_HEIGHT` off the height
 * there is to fill. The MARGINS are never compressed — the owner puts real work in one.
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
  const breaks = breaksBetween(shape.periods, startMinutes, endMinutes);
  const breakMinutes = breaks.reduce((total, hole) => total + hole.endMinutes - hole.startMinutes, 0);
  const workingMinutes = Math.max(1, spanMinutes - breakMinutes);
  const bandBudget = breaks.length * BREAK_BAND_HEIGHT;

  const pixelsPerHour =
    options.fitHeight !== undefined && options.fitHeight > 0
      ? clamp(
          ((options.fitHeight - bandBudget) / workingMinutes) * MINUTES_PER_HOUR,
          MIN_PIXELS_PER_HOUR,
          MAX_PIXELS_PER_HOUR,
        )
      : (options.pixelsPerHour ?? DEFAULT_PIXELS_PER_HOUR);
  const pixelsPerMinute = pixelsPerHour / MINUTES_PER_HOUR;

  const segments = buildSegments(startMinutes, endMinutes, breaks, pixelsPerMinute);
  const last = segments[segments.length - 1];
  const exactHeight = last.startY + (last.endMinutes - last.startMinutes) * last.pixelsPerMinute;

  const yOf = (minutes: number): number => {
    const clamped = clamp(minutes, startMinutes, endMinutes);
    const segment = segmentOf(segments, (candidate) => candidate.startMinutes <= clamped);
    return segment.startY + (clamped - segment.startMinutes) * segment.pixelsPerMinute;
  };

  const minutesAt = (y: number): number => {
    const clamped = clamp(y, 0, exactHeight);
    const segment = segmentOf(segments, (candidate) => candidate.startY <= clamped);
    return clamp(
      Math.round(segment.startMinutes + (clamped - segment.startY) / segment.pixelsPerMinute),
      startMinutes,
      endMinutes,
    );
  };

  return {
    startMinutes,
    endMinutes,
    spanMinutes,
    pixelsPerMinute,
    height: Math.round(exactHeight),
    yOf,
    heightBetween: (fromMinutes, toMinutes) => Math.max(1, yOf(toMinutes) - yOf(fromMinutes)),
    minutesAt,
    clampStart: (minutes, durationMinutes = 0) =>
      clamp(minutes, startMinutes, Math.max(startMinutes, endMinutes - durationMinutes)),
  };
}

/**
 * The holes BETWEEN two working periods, clipped to the axis. Not the same set as `nonWorkingBands` —
 * this one starts at the first period and stops at the last, so a visual margin is never in it.
 */
function breaksBetween(
  periods: readonly WorkPeriod[],
  startMinutes: number,
  endMinutes: number,
): WorkPeriod[] {
  const sorted = [...periods].sort((a, b) => a.startMinutes - b.startMinutes);
  const holes: WorkPeriod[] = [];
  let cursor: number | undefined;

  for (const period of sorted) {
    if (cursor !== undefined && period.startMinutes > cursor) {
      const from = clamp(cursor, startMinutes, endMinutes);
      const to = clamp(period.startMinutes, startMinutes, endMinutes);
      if (to > from) holes.push({ startMinutes: from, endMinutes: to });
    }
    cursor = cursor === undefined ? period.endMinutes : Math.max(cursor, period.endMinutes);
  }

  return holes;
}

/**
 * A break is drawn at `min(what it would have been, BREAK_BAND_HEIGHT)`: compressing may only ever
 * make a hole SMALLER, so a ten-minute break is not stretched into a 28 px band.
 */
function buildSegments(
  startMinutes: number,
  endMinutes: number,
  breaks: readonly WorkPeriod[],
  pixelsPerMinute: number,
): AxisSegment[] {
  const segments: AxisSegment[] = [];
  let cursor = startMinutes;
  let y = 0;

  const push = (from: number, to: number, scale: number): void => {
    segments.push({ startMinutes: from, endMinutes: to, startY: y, pixelsPerMinute: scale });
    y += (to - from) * scale;
  };

  for (const hole of breaks) {
    if (hole.startMinutes > cursor) push(cursor, hole.startMinutes, pixelsPerMinute);
    const holeMinutes = hole.endMinutes - hole.startMinutes;
    push(
      hole.startMinutes,
      hole.endMinutes,
      Math.min(holeMinutes * pixelsPerMinute, BREAK_BAND_HEIGHT) / holeMinutes,
    );
    cursor = hole.endMinutes;
  }

  if (cursor < endMinutes || segments.length === 0) push(cursor, endMinutes, pixelsPerMinute);
  return segments;
}

/** The last segment the predicate holds for; the first when it holds for none. */
function segmentOf(
  segments: readonly AxisSegment[],
  holds: (segment: AxisSegment) => boolean,
): AxisSegment {
  for (let index = segments.length - 1; index > 0; index -= 1) {
    if (holds(segments[index])) return segments[index];
  }
  return segments[0];
}

// Bands: the grey stripes for the visual margins and the lunch break

export type BandKind = 'marginTop' | 'lunch' | 'marginBottom';

export interface TimelineBand {
  kind: BandKind;
  startMinutes: number;
  endMinutes: number;
}

/**
 * Derived rather than read from Settings so an axis widened by `cover` still paints all of it grey —
 * grey means "the engine will not put work here", which is exactly "outside a period".
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
      // A day with no periods at all (closed, or a broken configuration) is one single band;
      // calling it the bottom margin would be a lie, so it stays a top one.
      kind: sorted.length === 0 ? 'marginTop' : 'marginBottom',
      startMinutes: cursor,
      endMinutes: timeline.endMinutes,
    });
  }

  return bands;
}

/**
 * The middle of the day's LONGEST WORKING STRETCH. The middle of the COLUMN is a trap — 07:00-20:30
 * has its midpoint at 13:45, on the edge of the grey lunch band, where the word read as debris. A day
 * with no periods falls back to the middle of the axis.
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

// The time axis

export interface AxisTick {
  minutes: number;
  /** A period edge or an end of the axis: labelled and drawn stronger. */
  boundary: boolean;
}

/** Every edge of the day, then EVERY HOUR, an hour giving way where it would collide. */
export function axisTicks(periods: readonly WorkPeriod[], timeline: Timeline): AxisTick[] {
  const ticks = new Map<number, AxisTick>();
  // Measured as BOXES IN PIXELS: minutes cannot answer it on a piecewise axis, and the two labels at
  // the ends are anchored differently (`.tickFirst` / `.tickLast`), so they reach a whole label
  // further into the column than a centred one does.
  const boxes: { top: number; bottom: number }[] = [];

  /** Keeps a tick unless a label already placed is standing in its box. */
  const add = (minutes: number, boundary: boolean): void => {
    if (minutes < timeline.startMinutes || minutes > timeline.endMinutes) return;
    const existing = ticks.get(minutes);
    if (existing !== undefined) {
      if (boundary) existing.boundary = true;
      return;
    }
    const box = labelBox(minutes, timeline);
    if (boxes.some((other) => overlaps(box, other))) return;
    ticks.set(minutes, { minutes, boundary });
    boxes.push(box);
  };

  // In precedence order, most meaningful first, since a label box can belong to only one tick. The
  // ends are deliberately NOT forced.
  for (const period of [...periods].sort((a, b) => a.startMinutes - b.startMinutes)) {
    add(period.startMinutes, true);
    add(period.endMinutes, true);
  }

  add(timeline.startMinutes, true);
  add(timeline.endMinutes, true);

  for (
    let minutes = ceilTo(timeline.startMinutes + 1, MINUTES_PER_HOUR);
    minutes < timeline.endMinutes;
    minutes += MINUTES_PER_HOUR
  ) {
    add(minutes, false);
  }

  return [...ticks.values()].sort((a, b) => a.minutes - b.minutes);
}

/** The pixels a label printed at `minutes` covers, as the stylesheet anchors it. */
function labelBox(minutes: number, timeline: Timeline): { top: number; bottom: number } {
  const y = timeline.yOf(minutes);
  if (minutes <= timeline.startMinutes) return { top: y, bottom: y + TICK_LABEL_HEIGHT };
  if (minutes >= timeline.endMinutes) return { top: y - TICK_LABEL_HEIGHT, bottom: y };
  return { top: y - TICK_LABEL_HEIGHT / 2, bottom: y + TICK_LABEL_HEIGHT / 2 };
}

function overlaps(
  one: { top: number; bottom: number },
  other: { top: number; bottom: number },
): boolean {
  return one.top - MIN_TICK_CLEARANCE < other.bottom && other.top - MIN_TICK_CLEARANCE < one.bottom;
}

// Pointer position -> a slot on the calendar

/** One measured day column, in client (viewport) coordinates. */
export interface ColumnBox {
  date: string;
  left: number;
  width: number;
}

export interface GridMetrics {
  /** Client Y of the top of the timeline — the same for all seven columns. */
  top: number;
  columns: ColumnBox[];
  /**
   * The VISIBLE grid box and the hot strip at each end of it. Not derived from `columns`: on a narrow
   * window the columns scroll sideways INSIDE the frame, so a zone pinned to Monday's left edge would
   * sit where no pointer can reach. The widths are measured here because only the grid knows how wide
   * the time-axis gutter is.
   */
  frame: {
    left: number;
    right: number;
    leftZone: number;
    rightZone: number;
  };
}

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
  snappedMinutes: number;
}

/**
 * `undefined` only when the pointer has left the grid horizontally; vertically it clamps, so a drag
 * towards the window edge still tracks the first and last minute of the day.
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
 * Keeps a dropped unit inside the day it is dropped on. `Timeline.clampStart` is not enough:
 * `durationMinutes` is NET working minutes while the axis is CLOCK minutes, and `cover` widens the
 * axis to show the very row that overran. So the limit is the day's own last manual window, and an
 * illegal release is clamped down to the latest START that fits — the set of legal starts is not an
 * interval. The cost is a dead zone the preview has to SAY out loud — see `DragPreview.clamped`.
 */
export function clampDropStart(
  manualWindows: readonly WorkPeriod[],
  startMinutes: number,
  durationMinutes: number,
  timeline: Timeline,
): number {
  const onAxis = timeline.clampStart(startMinutes);
  if (clockEndOf(manualWindows, onAxis, durationMinutes) <= dayEndMinutes(manualWindows)) return onAxis;
  return timeline.clampStart(Math.min(onAxis, latestStartFor(manualWindows, durationMinutes)));
}

/**
 * The queue rank a drop should write. A block's (date, start) IS its place in the queue and the order
 * is total, so a drop landing exactly on an existing start loses the tie to the older row and the
 * drag appears to have done nothing; the nudge is how "before this one" is expressed. A PINNED
 * placement is never nudged: there the minute is the clock and it is what gets stored.
 */
export function rankFor(
  snappedMinutes: number,
  takenStarts: readonly number[],
  clampStart: (minutes: number) => number,
  /** The placement keeps this exact minute, so it is a time and not a rank. */
  pinned: boolean,
): number {
  if (pinned) return snappedMinutes;
  if (!takenStarts.includes(snappedMinutes)) return snappedMinutes;
  const nudged = clampStart(snappedMinutes - 1);
  // Clamping may have pushed it back onto the tie (a drop on the very first minute of
  // the axis); after it is then the only place left.
  if (nudged !== snappedMinutes) return nudged;
  return clampStart(snappedMinutes + 1);
}

// Resizing

/**
 * The longest a row starting at `startMinutes` may be, in NET working minutes over the day's MANUAL
 * WINDOWS. The limit is the end of the day's LAST window, so the lunch break is skipped rather than
 * hit. A row starting past the last window keeps its hours and can never be grown; one a settings
 * change stranded INSIDE the break reaches as far as one starting at 15:30, because that is where the
 * write path lays its hours out.
 */
export function maxDurationFrom(
  startMinutes: number,
  manualWindows: readonly WorkPeriod[],
  reach: ResizeReach,
): number {
  return Math.max(SNAP_MINUTES, netMinutesOf(reachRuns(manualWindows, startMinutes, reach)));
}

export interface ResizeReach {
  /** The end of the day's last manual window — `dayEndMinutes(manualWindows)`. */
  endOfDayMinutes: number;
  /** The stretch's current net minutes, so a row already outside the windows keeps them. */
  currentMinutes?: number;
}

/**
 * The net working minutes a bottom-edge drag released at `pointerMinutes` means for a row starting at
 * `startMinutes`. The lunch break contributes ZERO — a row at 10:00 dragged to 17:30 is 6 h — so
 * releasing anywhere inside it answers the same as releasing at 14:00. Snapped on the CLOCK before it
 * is converted, and floored at one snap so a row can never vanish.
 */
export function durationTo(
  startMinutes: number,
  pointerMinutes: number,
  manualWindows: readonly WorkPeriod[],
  reach: ResizeReach,
  snap: number = SNAP_MINUTES,
): number {
  const runs = reachRuns(manualWindows, startMinutes, reach);
  const net = netMinutesBetween(runs, startMinutes, snapTo(pointerMinutes, snap));
  return clamp(net, snap, maxDurationFrom(startMinutes, manualWindows, reach));
}

// Internals

/**
 * The clock a bottom-edge drag may cover: the reachable runs up to the END OF THE DAY, plus the tail
 * of a row that already runs past it, so such a row's hours stay reachable and the edge can be
 * dragged back up. Nothing beyond it is.
 */
function reachRuns(
  manualWindows: readonly WorkPeriod[],
  startMinutes: number,
  reach: ResizeReach,
): WorkPeriod[] {
  const runs = reachableRuns(manualWindows, startMinutes, reach.endOfDayMinutes);
  const ownEnd = clockEndOf(manualWindows, startMinutes, reach.currentMinutes ?? 0);
  const last = runs[runs.length - 1];
  if (last !== undefined && ownEnd > last.endMinutes) {
    runs.push({ startMinutes: last.endMinutes, endMinutes: ownEnd });
  }
  return runs;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function floorTo(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function ceilTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}
