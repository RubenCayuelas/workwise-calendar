/**
 * Dragging to the edge changes week: where the hot zone is, how long the hold is, and how fast it
 * repeats. Pure arithmetic on pixels and milliseconds, so the three numbers that decide whether
 * the gesture feels good can be tested without a browser.
 */

/** Which way the calendar pages. Named for the answer, not for the side of the screen. */
export type EdgeSide = 'previous' | 'next';

/**
 * The NARROWEST the hot strip is ever drawn, at either end of the grid FRAME. 40 px is a target a
 * mouse acquires without aiming, and it is the whole right-hand strip: no gutter on that side, so
 * every pixel of it is Sunday's. The LEFT strip is the whole time-axis gutter whenever that is
 * wider (58 px) — it belongs to no day, and 40 px there ended six pixels short of the hour labels.
 */
export const EDGE_ZONE_PX = 40;

/** How long the pointer must dwell in the zone before the FIRST page turn. */
export const EDGE_FIRST_DELAY_MS = 500;

/**
 * The wait before the second and EVERY later turn of one hold — one number, no ramp, chosen so that
 * STOPPING on the week the hold was aimed at is possible and the rail's date label can be read at
 * that pace. A test holds it inside the 600-1000 ms window. Bounded from below by something this
 * file cannot see: the next turn waits for the week the last one asked for to ARRIVE.
 */
export const EDGE_REPEAT_DELAY_MS = 800;

/**
 * The frame's inner edges in viewport coordinates and the width of the strip at each end — what
 * `GridMetrics.frame` carries, measured in the one place that measures.
 */
export interface EdgeBounds {
  left: number;
  right: number;
  /** The time-axis gutter, or `EDGE_ZONE_PX` when that is wider. */
  leftZone: number;
  /** `EDGE_ZONE_PX`: there is no gutter on that side. */
  rightZone: number;
}

/**
 * Which edge the pointer is in, or `null` for the whole middle of the grid. Past the frame counts
 * as being in the zone: a pointer that has left the frame is not aiming at any column anyway.
 *
 * A frame too narrow to hold both strips and anything in between has NO zone at all — there the
 * two would overlap and every drag would sit in one of them.
 */
export function edgeSideAt(x: number, bounds: EdgeBounds): EdgeSide | null {
  if (bounds.right - bounds.left <= bounds.leftZone + bounds.rightZone) return null;
  if (x < bounds.left + bounds.leftZone) return 'previous';
  if (x > bounds.right - bounds.rightZone) return 'next';
  return null;
}

/**
 * The wait before the turn after `turns` have already fired in this hold. Two values, no ramp: the
 * first turn must not fire by accident, every later one must be one the owner can stop on.
 */
export function edgeDelayFor(turns: number): number {
  return turns <= 0 ? EDGE_FIRST_DELAY_MS : EDGE_REPEAT_DELAY_MS;
}

/**
 * A hold in progress at one edge, as the grid needs to draw it. `delayMs` is published rather than
 * re-derived by the rail because the fill animation must last exactly as long as the timer that is
 * running: two numbers meaning "the wait" is how a progress bar finishes before what it measures.
 */
export interface EdgeHold {
  side: EdgeSide;
  /** Page turns already made in this hold. 0 while the first one is counting down. */
  turns: number;
  /** The wait now running, in ms. The rail's fill is animated over exactly this. */
  delayMs: number;
  /**
   * The turn has been asked for and the week has not arrived yet. The rail says so — a bar that has
   * finished filling over a calendar that has not moved reads as the gesture having failed.
   */
  waiting: boolean;
}
