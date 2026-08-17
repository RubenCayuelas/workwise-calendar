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
 * The drop and resize increment. Quarters of an hour: the shop plans in halves, but
 * a quarter makes the drag feel like it follows the mouse instead of jumping.
 */
export const SNAP_MINUTES = 15;

/** A row shorter than this cannot show its own hours, only its name. */
export const MIN_LABEL_HEIGHT = 34;

/**
 * THE SHORTEST ROW THAT CAN HOST THE HOVER ACTION BAR INSIDE ITSELF.
 *
 * The bar is 24 px tall and sits 3 px down from the row's top edge; the resize handle takes
 * the bottom `min(10px, 34%)`. Below this height the two meet and the row has NO surface of
 * its own left: measured on the running app (2026-08-13), a half-hour row is 24 px tall, so
 * the bar covered all of it and overhung by 4 px, and every press on the row landed on a
 * button — *Cerrar el día aquí* down the middle, *Eliminar* at the right end. The drag still
 * started (a press on the bar begins the same move), but the CLICK could no longer open the
 * job, and the button it hit instead was one the owner never aimed at.
 *
 * 56 px leaves at least 19 px of body between the bar and the handle, which is a target a
 * mouse on a shop PC can actually acquire. Above it the bar stays where the wireframe puts
 * it; below it the bar lifts off the row entirely (`.detached` in CalendarBlock.module.css)
 * — the same answer `MIN_BLOCK_GRAB_WIDTH` gives on the other axis.
 */
export const MIN_ACTIONS_HEIGHT = 56;

/**
 * The hover action bar's own height (`--ww-control-height-sm` plus its inset), which the
 * grid needs as a number for one decision: a cramped row docks its bar against the OUTSIDE
 * of its top edge, and a row with less than this above it on the axis has nowhere to put it
 * but under the sticky day header, so it docks below instead.
 */
export const ACTIONS_BAR_HEIGHT = 27;

/**
 * One button of the hover action bar: `--ww-control-height-sm` (24 px) plus the 2 px gap
 * the bar puts between them. The bar is as wide as the buttons it happens to be showing —
 * three on an ordinary row, five when *back to automatic* and *cerrar el día aquí* are
 * both offered — so its width is a number the component works out, not a constant.
 */
export const ACTIONS_BUTTON_WIDTH = 26;

/**
 * THE NARROWEST STRIP OF BLOCK THAT IS STILL A TARGET FOR THE MOUSE, once the action bar
 * has taken its share of the top edge.
 *
 * The second half of the same defect `MIN_ACTIONS_HEIGHT` closes, on the other axis and
 * still open until 2026-08-14: the bar is anchored at the block's right edge and it takes
 * the WHOLE top of a narrow block, name included — on a weekend column (116 px floor) and
 * on any weekday column once the window is small enough. The block is tall, so it is not
 * `cramped` and the bar stayed inside it; a click on the block's own name therefore landed
 * on a button — *Eliminar* at the right end, *Cerrar el día aquí* down the middle — and a
 * gesture that quietly does something else is worse than one that does nothing.
 *
 * 44 px is about two characters of the job's name plus its padding: enough that the owner
 * can see there is block left to press, and small enough that the bar is not thrown out of
 * every column on the shop's own monitor. Below it the bar leaves the block's hit area
 * altogether and docks against the outside of its top edge, exactly as a cramped row's
 * does — one behaviour, two reasons to reach it.
 */
export const MIN_BLOCK_GRAB_WIDTH = 44;

/**
 * Does the action bar leave enough of this block to press? `width` is the block's own
 * width in pixels (a lane's share of the column, not the column), and `buttons` is how
 * many the bar is showing.
 *
 * `null` means "not measured yet", which is answered `true`: the bar stays where the
 * wireframe puts it until the grid has been measured, and one frame of the old placement
 * is better than one frame of a bar hanging over the row above.
 */
export function blockHoldsActions(width: number | null, buttons: number): boolean {
  if (width === null) return true;
  return width - buttons * ACTIONS_BUTTON_WIDTH >= MIN_BLOCK_GRAB_WIDTH;
}

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
 * KEEPS A DROPPED UNIT INSIDE THE DAY IT IS DROPPED ON.
 *
 * `Timeline.clampStart` keeps a start on the AXIS, which is a different question and not
 * enough on its own: `durationMinutes` is NET working minutes while the axis is CLOCK
 * minutes, so `axisEnd − duration` let a 6 h unit start at 13:15 — where it needs 7 h 30 of
 * clock — and the server stored `13:15-14:00` plus `15:30-20:45`, a quarter of an hour past
 * the end of the day (invariant 3). The axis is worse than useless here, because `cover`
 * widens it to show the very row that overran.
 *
 * So the limit is the day's own last manual window (`dayEndMinutes`), and an illegal
 * release is clamped DOWN to the latest start that fits (`latestStartFor`) rather than to
 * an interval end: the set of legal starts is not an interval. A release inside the lunch
 * band is legal whenever the row, stored uncut, still ends inside the day — that latitude
 * is `segmentDroppedRow`'s and an Open Decision in CLAUDE.md, so it is preserved exactly.
 *
 * IT BINDS ON EVERY DAY, INCLUDING THE ONES THE ENGINE REFLOWS, and that is not obvious:
 * there the release is only a queue rank, so the unit's own length looks like it should
 * have no say in it. The reason it does is that the REQUEST still carries the whole unit's
 * duration, and a drop that lands in manual-only time is stored exactly as sent (see
 * `pinsTheRow` in src/lib/operations/blocks.ts) — so an unclamped rank on an auto day comes
 * straight back as 409 `row-past-day-end`. Measured on the running app, 2026-08-13: a 6 h
 * unit ranked at 18:00 on a reflowing Wednesday is refused, at 13:00 it is stored.
 *
 * The cost is a dead zone: a 6 h unit cannot be aimed below 13:00, and the ghost stops
 * following the pointer there. That is why the preview says so out loud rather than
 * silently freezing — see `DragPreview.clamped`.
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
 * The queue rank a drop should write.
 *
 * A block's (date, start) IS its place in the queue, and the order is total: ties are
 * broken by `created_at` then `id`, so a drop landing exactly on an existing block's
 * start silently loses to the older row and the drag appears to have done nothing.
 * The fix is to rank strictly between neighbours.
 *
 * THE TIE ALWAYS RESOLVES *BEFORE* THE ROW IT LANDED ON — decided with the owner,
 * 2026-08-13: "landing on the start means «put me before this one»; the row underneath
 * stays whole and follows. To cut a row, release below its start." The direction used to
 * come from the unsnapped pointer instead, and a hair BELOW the start produced the defect
 * that decision was taken to remove: ranked one minute AFTER, the drop cuts the row it
 * meant to precede, and the cut lands one minute in — `Beta 08:00-08:01 (0,02 h)`,
 * `Alfa 08:01-10:01`, `Beta 10:01-12:00`. A one-minute row is below `MIN_ROW_MINUTES`,
 * nothing on screen asked for it, and the two halves of a 15-minute snap gave opposite
 * answers for a difference the owner cannot see or aim at.
 *
 * SINCE THIRDS THE AIM CANNOT LAND A HAIR BELOW A START AT ALL (`aimAtThirds` in
 * dropAim.ts): over a row there are three targets and its own start is one of them, so a
 * tie is the ORDINARY way to say "before this one" rather than an accident of the pixel.
 * That is why the unsnapped pointer minute is gone from this function — it was the input
 * that made the direction unaimable — while the nudge stays, because it is the mechanism
 * "before" is expressed WITH. One minute is enough: the rank is an ordering, not a time,
 * and the reflow rewrites the position anyway.
 *
 * WHICH IS WHY A PINNED PLACEMENT IS NEVER NUDGED. Where the row keeps the minute it was
 * released on (`pinsTheRow`: the weekend, the colchón, a visual margin, the lunch band, a
 * locked unit) that minute is not an ordering at all — it is the clock, and it is stored.
 * Nudged, a Saturday drop released on 10:00 came back as `09:59`, the row it landed on was
 * re-placed at `11:59`, and their durations read 2,02 h and 1,98 h: minutes the owner never
 * drew, on a day whose whole promise is that what they drew is what they get (matrix
 * N-3/N-4, 2026-08-13). Nothing there needs the tie broken — a pinned drop is resolved
 * against the day's fixed rows by merge and cut, and queue order never reaches them.
 *
 * `clampStart` is the caller's clamp, not the axis's: a nudge must not be able to push the
 * last legal start one minute past the end of the day. Passing the function keeps that one
 * decision in one place (`clampDropStart`) instead of restating it here.
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

// ---------------------------------------------------------------------------
// Resizing
// ---------------------------------------------------------------------------

/**
 * The longest a row starting at `startMinutes` may be, in NET working minutes.
 *
 * Measured over the day's MANUAL WINDOWS — the periods plus the visual margins — because
 * a resize is a hand action and both are hand time. So the limit is the end of the day's
 * LAST window, not the end of the window the row happens to start in: the lunch break is
 * skipped rather than hit.
 *
 * It used to stop at the period's end, which is the defect the owner reported: "al
 * aumentar de tamaño un bloque este no pasa de las horas de comer y las de margen". A row
 * starting at 10:00 could not be made longer than 4 h, and the hour of margin the Settings
 * screen offers could not be reached by any gesture at all.
 *
 * A row that starts in a HOLE (the lunch band, or past the last window) still stops where
 * that hole does — see `reachableRuns`. Nothing may swallow working time it does not own.
 *
 * THE REACH IS THE DAY'S OWN END, never the axis's. The axis is widened by `cover` to keep
 * a row left over from a longer working day visible, and passing that widened end let the
 * drag grow the row into the space its own overrun had opened — `19:30-20:30` with the
 * bottom margin set to 0 could be dragged to 21:00 (invariant 3). `ResizeReach.currentMinutes`
 * is what keeps that row honest in the other direction: the hours already in it are reachable
 * (CLAUDE.md keeps them), so it can be left alone or shortened, and never grown.
 */
export function maxDurationFrom(
  startMinutes: number,
  manualWindows: readonly WorkPeriod[],
  reach: ResizeReach,
): number {
  return Math.max(SNAP_MINUTES, netMinutesOf(reachRuns(manualWindows, startMinutes, reach)));
}

/**
 * How far down a bottom-edge drag may reach, as the two numbers that decide it.
 *
 * Both are the DAY's, not the axis's, and the second exists for one documented shape: a row
 * that already sits outside the manual windows because the margin under it was set to 0.
 */
export interface ResizeReach {
  /** The end of the day's last manual window — `dayEndMinutes(manualWindows)`. */
  endOfDayMinutes: number;
  /** The stretch's current net minutes, so a row already outside the windows keeps them. */
  currentMinutes?: number;
}

/**
 * The net working minutes a bottom-edge drag released at `pointerMinutes` means for a row
 * starting at `startMinutes` — the number the resize is saved with.
 *
 * THE OWNER'S OWN WORKED EXAMPLE: a row starting at 10:00 dragged to 17:30 is 6 h, being
 * `10:00-14:00` plus `15:30-17:30`. "en vez de la hora del medio sumarla, ignorarla." The
 * lunch break therefore contributes ZERO, so releasing anywhere inside it gives exactly
 * the same answer as releasing at 14:00 — the pointer crossing the grey band is a dead
 * zone rather than a jump.
 *
 * Snapped on the CLOCK before it is converted, so the drag follows the mouse in quarters
 * of an hour the way it always has, floored at one snap so a row can never vanish, and
 * capped by `maxDurationFrom` — the same cap, so the two can never disagree about where
 * the day ends.
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

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The clock a bottom-edge drag may cover: the reachable runs up to the END OF THE DAY, plus
 * the tail of a row that already runs past it.
 *
 * That tail is the one place the two questions come apart. A row holding `19:30-20:30` after
 * the bottom margin was set to 0 is legitimate (CLAUDE.md: the owner loses the margin as a
 * target, not the hours already in it) — so those minutes stay reachable, which is what lets
 * the owner release the edge where it already is, or drag it back up. Nothing beyond them is.
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

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}
