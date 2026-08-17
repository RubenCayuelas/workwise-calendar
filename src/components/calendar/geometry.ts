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
 *
 * They bound the scale of WORKING time only; the break between two periods is drawn at
 * `BREAK_BAND_HEIGHT` whatever the scale. See `createTimeline`.
 */
export const MIN_PIXELS_PER_HOUR = 42;
export const MAX_PIXELS_PER_HOUR = 96;

/**
 * THE HEIGHT OF THE BREAK BETWEEN TWO WORKING PERIODS — the lunch band — in pixels,
 * whatever the scale the rest of the axis is drawn at.
 *
 * The owner's own words, 2026-08-17: *«Haz el hueco del medio para la comida pequeño, para
 * indicar que hay un hueco pero es despreciable ya que no podemos trabajar ahí.»* At the
 * fitted scale the documented 14:00-15:30 break took 82 px of a 742 px column — a ninth of
 * the screen spent on time nobody can work, and the reason the axis had room to label only
 * 07:00, 08:00, 11:00, 14:00… while an owner reading "how long is the shop booked" was
 * counting three-hour jumps in their head.
 *
 * 28 px is the smallest band that still holds its own two labels: the axis prints the times
 * on BOTH edges (14:00 and 15:30), each an 18 px line box centred on its rule, so anything
 * under ~26 px has them touching. It reads as a seam rather than as a stretch of day, and
 * the 54 px it gives back is what pays for a label on every hour (`axisTicks`) — on that
 * same column the working hour goes from 55.0 px to 59.5 px.
 *
 * WHAT A POINTER INSIDE THE BAND MEANS IS UNCHANGED, and it is deliberate:
 *
 * - the mapping stays an exact inverse in there — `minutesAt(yOf(m)) === m` for every minute
 *   of the band — because the drag layer rests on that everywhere, not merely where work can
 *   sit (*One Axis Per Gesture*). The band is simply drawn at its own scale: ~3.2 minutes to
 *   the pixel instead of ~1, so one `SNAP_MINUTES` step is ~4.7 px;
 * - a RESIZE released in there is a DEAD ZONE by arithmetic, not by paint: `durationTo`
 *   counts NET working minutes, so 14:00, 15:00 and 15:29 have always committed the same
 *   duration. Compressing the band shrinks a zone in which the pointer already did nothing;
 * - a DROP released in there still lands on the minute it was released on and padlocks the
 *   row (manual-only time — CLAUDE.md, *The Padlock Is the Only Pin*; how the row is then
 *   segmented is Open Decision 5 and is untouched). It is now a 28 px target that has to be
 *   aimed at on purpose, which is the wanted direction: nobody works there.
 */
export const BREAK_BAND_HEIGHT = 28;

/**
 * One axis label's own line box, in pixels: `--ww-text-sm` (12 px) at the page's line
 * height, measured at 18 px on the running app. Labels are what compete for room on the
 * axis, so the room is measured in labels.
 */
const TICK_LABEL_HEIGHT = 18;

/** The clear space two labels must leave between them to read as two labels. */
const MIN_TICK_CLEARANCE = 2;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

/**
 * The vertical scale of the grid: one shared mapping for all seven columns.
 *
 * IT IS PIECEWISE (since 2026-08-17): working time is drawn at `pixelsPerMinute`, and the
 * break between two periods is squeezed into `BREAK_BAND_HEIGHT` whatever that scale is. So
 * there is no such thing as "how tall is 90 minutes" without saying WHERE — which is why the
 * only two questions this interface answers are `heightBetween`, over two times on the clock,
 * and `yOf`, from the top of the column.
 */
export interface Timeline {
  /** Top of the axis, in minutes from midnight. */
  readonly startMinutes: number;
  /** Bottom of the axis. */
  readonly endMinutes: number;
  /** The axis's span on the CLOCK, compressed break included. */
  readonly spanMinutes: number;
  /**
   * The scale of WORKING time — the one every block is drawn at. A compressed break is
   * NOT on this scale, so this may not be used to convert a span that contains one.
   */
  readonly pixelsPerMinute: number;
  /** The height a day column must have, in pixels. */
  readonly height: number;
  /** Offset of a time from the top of a column. Monotonic, and clamped to the axis. */
  yOf(minutes: number): number;
  /**
   * The pixels between two times on the clock, a compressed break included: the height of
   * anything drawn from `fromMinutes` to `toMinutes`. Never less than 1px, so nothing is
   * invisible.
   *
   * For everything a stored row can be it equals `duration * pixelsPerMinute` exactly — no
   * block straddles a break (CLAUDE.md, invariant 3), so no block contains a compressed
   * segment. It is the gap covering the afternoon and the ghost of a drop released inside
   * the band that need the other answer.
   */
  heightBetween(fromMinutes: number, toMinutes: number): number;
  /** The time at an offset from the top of a column. Clamped to the axis. */
  minutesAt(y: number): number;
  /** Keeps a start time on the axis, leaving room for `durationMinutes`. */
  clampStart(minutes: number, durationMinutes?: number): number;
}

/**
 * One stretch of the axis drawn at a single scale: the runs of working time at
 * `pixelsPerMinute`, and one compressed segment per break between two periods.
 *
 * Held as an array rather than as a formula because both directions have to agree exactly.
 * `yOf` picks the LAST segment that starts at or before the time asked for, and `minutesAt`
 * the last that starts at or before the pixel asked for — so a time on a seam is converted
 * with a zero offset into the segment BELOW it, and both functions return the stored
 * `startY` / `startMinutes` there literally, where a rounding error would otherwise live.
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
 *
 * THE SCALE IS FITTED OVER WORKING MINUTES ONLY. Each break between two periods costs a
 * flat `BREAK_BAND_HEIGHT`, that cost comes off the height there is to fill, and what is
 * left is spread over the minutes the shop can actually use. On the documented shift and
 * the shop's own window that is 12 h in 714 px instead of 13.5 h in 742 px — every working
 * hour is ~8% taller than it was, which is where the room for an hourly label comes from.
 *
 * THE MARGINS ARE NEVER COMPRESSED. They are outside the periods, not between two of them,
 * and the owner puts real work in them by hand — an hour of margin has to be as tall as an
 * hour of the morning or the block sitting in it would lie about its length.
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
  // What the fitted scale is spread over, and what the bands take off the top before it is.
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
 * The holes BETWEEN two working periods, clipped to the axis: what the axis compresses.
 *
 * Not the same set as `nonWorkingBands`, and the difference is the whole rule: this one
 * starts at the first period and stops at the last, so the visual margins — the non-working
 * time OUTSIDE the periods, which is hand time and holds real work — are never in it.
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
 * The axis cut into runs of one scale each, top to bottom and contiguous in both minutes
 * and pixels.
 *
 * A break is drawn at `min(what it would have been, BREAK_BAND_HEIGHT)`: compressing is
 * only ever allowed to make the hole SMALLER, so a shop with a ten-minute break does not
 * find it stretched into a band three times its size.
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
 * The times the axis labels: every edge of the day, and then EVERY HOUR.
 *
 * The owner, 2026-08-17: *«En la división de horas de 8 a 11 es un salto muy grande, coloca
 * todas las horas.»* The axis used to label the edges plus one interior tick per three hours
 * of period, which on the documented shift printed 08:00 and then 11:00 — so reading how far
 * down the morning a block sat meant measuring a three-hour box by eye. The room for the
 * hourly labels is what compressing the break gave back; the two requests were one.
 *
 * AN HOUR IS DROPPED WHERE IT WOULD COLLIDE, never a period edge: the edges are the times
 * the whole screen is stated over. That is what keeps 15:00 out of a 28 px lunch band and
 * what protects a shift whose period starts at 15:50 from printing 15:50 over 16:00.
 */
export function axisTicks(periods: readonly WorkPeriod[], timeline: Timeline): AxisTick[] {
  const ticks = new Map<number, AxisTick>();
  /*
   * Measured as BOXES IN PIXELS, because that is the real question — two labels overlap or
   * they do not. Minutes cannot answer it: on a piecewise axis the same two minutes are not
   * always the same gap, and the two labels at the ends of the axis are anchored
   * differently from the rest (`.tickFirst` / `.tickLast` in WeekGrid.module.css hang them
   * inside the frame instead of centring them on their rule), so they reach a whole label
   * further into the column than a centred one does. That last detail is not a nicety: at
   * the shop's own window 20:00 and 20:30 are 26 px apart, which passes any centre-to-centre
   * test and still printed one over the other.
   */
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

  /*
   * IN PRECEDENCE ORDER, MOST MEANINGFUL FIRST, because a label box can only belong to one
   * of them and something has to give when two are closer than a line of type.
   *
   * 1. EVERY PERIOD EDGE, earliest first: the times the working day starts and stops. These
   *    are the times the shop is actually run by.
   * 2. THE TWO ENDS OF THE AXIS. They state the range, but each is only the outer lip of a
   *    visual margin — grey, hand-only time — so an edge outranks them.
   * 3. EVERY HOUR, which is what the owner asked for («coloca todas las horas») and what
   *    gives way first: an hour can be counted from its neighbours, an edge cannot.
   *
   * BOTH DEMOTIONS ARE REAL CONFIGURATIONS, not hypotheticals, and both were measured on the
   * running app on 2026-08-17:
   *
   * - AN EDGE AGAINST AN EDGE. A shift of `08:00-14:00` then `14:10-18:10` — which Settings
   *   accepts, and whose 10-minute break the band deliberately draws at its own 9 px rather
   *   than stretching to `BREAK_BAND_HEIGHT` — puts two edge labels ten minutes apart, and
   *   18 px of type does not fit in 9 px of axis. `14:00` and `14:10` printed one through the
   *   other, an unreadable smudge down the side of the calendar. The earlier survives: it is
   *   when work STOPS, and the boundary is not lost with its label, because the compressed
   *   band draws a solid rule on each of its own edges (`.bandBreak`).
   * - AN AXIS END AGAINST AN EDGE. The margins step in half hours (`HOUR_STEP`), so a 0.5 h
   *   margin is two clicks away, and at `MIN_PIXELS_PER_HOUR` half an hour is 21 px — less
   *   than one label. Ordered the other way this dropped `08:00`, the single most useful
   *   label on the axis, to keep the top lip of a grey band.
   *
   * The axis ends are NOT forced, which they were for one iteration. Forcing them coupled
   * this function to `.tickFirst` / `.tickLast` being applied by INDEX in WeekGrid: drop the
   * first tick and index 0 becomes a label the stylesheet hangs below its rule while
   * `labelBox` had modelled it as centred — the model and the paint disagreeing, which is
   * the exact defect class the piecewise axis was rewritten to remove. WeekGrid now keys
   * those two classes on the MINUTE (`tick.minutes === timeline.startMinutes`), matching
   * `labelBox`'s own test, so either end can be dropped safely.
   */
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
  /**
   * The VISIBLE grid box and the width of the hot strip at each end of it — everything
   * `edgeSideAt` needs to say whether the pointer is asking for another week.
   *
   * The box is deliberately not derived from `columns`: on a window too narrow for the
   * whole week the columns scroll sideways inside it, so a zone pinned to Monday's left
   * edge would sit where no pointer can reach. The frame is what the owner sees, which is
   * what "near the edge" means. The two widths are measured here for the same reason —
   * the left one is the time-axis gutter, and only the grid knows how wide that is.
   */
  frame: {
    left: number;
    right: number;
    leftZone: number;
    rightZone: number;
  };
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
