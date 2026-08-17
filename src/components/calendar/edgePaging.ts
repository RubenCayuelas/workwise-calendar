/**
 * DRAGGING TO THE EDGE CHANGES WEEK: where the hot zone is, how long the owner has to
 * hold it, and how fast it repeats. Pure arithmetic on pixels and milliseconds, so the
 * three numbers that decide whether the gesture feels good can be argued about — and
 * tested — without a browser.
 *
 * The owner asked for it after trying to move a block to the following week and failing:
 * «lo de arrastrar a la siguiente semana no sé cómo funciona o no lo he conseguido hacer
 * funcionar». It had been decided (2026-08-14) and never built, so there was nothing to
 * find. The whole design therefore has one extra requirement on top of working: it has to
 * be DISCOVERABLE without being told, which is what the rails in `WeekGrid` are for.
 *
 * THE ZONE IS MEASURED FROM THE GRID FRAME, NOT FROM THE COLUMNS. The frame is what the
 * owner sees; the columns can be scrolled sideways in a narrow window, and a zone pinned
 * to Monday's left edge would then sit outside the visible grid where no pointer can reach
 * it. It also makes the two sides come out usefully different:
 *
 * - on the LEFT the zone falls entirely inside the 58 px time-axis gutter, so no day
 *   column gives up a single pixel and nothing draggable is under it;
 * - on the RIGHT it takes the last 40 px of Sunday, which is the price of the gesture.
 *   Two things keep that honest: the dwell (a release inside the zone still drops on
 *   Sunday — only HOLDING there pages), and `EdgeHold.armed` below.
 *
 * THE DWELL IS THE WHOLE DESIGN. Paging the instant the pointer touches the edge would
 * make every drag towards the weekend a lottery; making it long would make the gesture
 * feel stuck, and the owner asked for «fluido y ligero». Half a second is long enough that
 * no drag that is merely PASSING through the zone ever fires, and short enough that a
 * deliberate hold does not feel ignored — and the rail fills over exactly that half
 * second, so the wait is legible rather than silent.
 *
 * THE REPEAT IS A METRONOME, NOT AN ACCELERATION (2026-08-17). It used to shorten — 320,
 * 240, then 200 ms — on the argument that the first turn had already proved the intent. What
 * that really proved is that a hold has no brakes: the owner reported it as «si mantengo el
 * ratón ahí empieza a ir como loco semana a semana», and measured, 2.5 s at the edge walked
 * from week 34 to week 41. Nobody at the edge of a calendar is looking two months out; they
 * are looking one or two weeks ahead and want to stop on one. So every repeat now waits the
 * same `EDGE_REPEAT_DELAY_MS`, and the number is chosen so that STOPPING is possible.
 */

/** Which way the calendar pages. Named for the answer, not for the side of the screen. */
export type EdgeSide = 'previous' | 'next';

/**
 * The NARROWEST the hot strip is ever drawn, in pixels, at either end of the grid FRAME.
 *
 * 40 px is a target a mouse acquires without aiming, and it is what the right-hand strip
 * is: there is no gutter on that side, so every pixel of it is Sunday's.
 *
 * THE LEFT STRIP IS THE WHOLE TIME-AXIS GUTTER whenever that is wider (it is 58 px), and
 * that is not generosity — it is the rail and the trigger being the same shape. The gutter
 * belongs to no day, so nothing is taken from anything by widening it; and a 40 px strip
 * ended six pixels short of the hour labels, leaving `08:00` reading as `0` down the side
 * of the screen for the whole drag. The grid measures the gutter (`GridMetrics.frame`) and
 * the rail draws itself over the same width, so neither can promise a trigger the other
 * does not have.
 */
export const EDGE_ZONE_PX = 40;

/** How long the pointer must dwell in the zone before the FIRST page turn. */
export const EDGE_FIRST_DELAY_MS = 500;

/**
 * The wait before the second and EVERY later turn of one hold — one number, unchanging.
 *
 * 800 ms, and the three things that pin it there:
 *
 * - IT HAS TO BE STOPPABLE. A hold is aimed at a week, and the owner has to be able to take
 *   the pointer out of the strip on the week they wanted. Human reaction to a change on
 *   screen is around 250 ms and the hand then has to travel; under about half a second the
 *   week they meant to stop on has already gone by, which is what «como loco» describes.
 * - IT HAS TO BE READABLE. The rail names its destination by DATES, and reading `24–30 ago
 *   2026` off a vertical label is not instant. A pace that outruns the label makes the label
 *   pointless, and the label is how the owner knows where they are going.
 * - IT HAS TO STAY ALIVE. Longer than about a second and the calendar feels stuck to the
 *   pointer, which is the failure the 500 ms first wait was tuned away from. 800 ms is a
 *   little over a week a second: brisk, and countable.
 *
 * What it costs, deliberately: the owner's own 2.5 s at the edge now travels **3 weeks**
 * instead of the nine that were measured. Longer journeys are the header's ‹ › buttons and
 * the arrow keys, which have no wait at all.
 *
 * It is bounded from below by something this file cannot see either: the next turn is not
 * scheduled until the week the last one asked for has ARRIVED (see `useBlockDrag`), so a slow
 * load paces the repeat rather than being outrun by it.
 */
export const EDGE_REPEAT_DELAY_MS = 800;

/**
 * The frame's inner edges in viewport coordinates, and how wide the strip at each end is
 * — what `GridMetrics.frame` carries, measured in the one place that measures.
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
 * WHICH EDGE THE POINTER IS IN, or `null` for the whole middle of the grid.
 *
 * Past the frame on either side counts as being in the zone: dragging a block off the
 * side of the calendar means the same thing as holding it at the very edge, and a pointer
 * that has left the frame is not aiming at any column anyway.
 *
 * A frame too narrow to hold both strips and anything in between has NO zone at all.
 * There the two would overlap and every drag would sit in one of them; a window that small
 * is not a window the shop uses, and refusing to page is the harmless answer.
 */
export function edgeSideAt(x: number, bounds: EdgeBounds): EdgeSide | null {
  if (bounds.right - bounds.left <= bounds.leftZone + bounds.rightZone) return null;
  if (x < bounds.left + bounds.leftZone) return 'previous';
  if (x > bounds.right - bounds.rightZone) return 'next';
  return null;
}

/**
 * The wait before the turn after `turns` have already fired in this hold.
 *
 * Two values and no ramp: the first turn is the one the owner has to be protected from
 * triggering by accident, every turn after it is one they have to be able to stop on.
 */
export function edgeDelayFor(turns: number): number {
  return turns <= 0 ? EDGE_FIRST_DELAY_MS : EDGE_REPEAT_DELAY_MS;
}

/**
 * A hold in progress at one edge, as the grid needs to draw it.
 *
 * `delayMs` is published rather than re-derived by the rail because the fill animation
 * must last exactly as long as the timer that is running: two numbers meaning "the wait"
 * is how a progress bar ends up finishing before, or after, the thing it is measuring.
 */
export interface EdgeHold {
  side: EdgeSide;
  /** Page turns already made in this hold. 0 while the first one is counting down. */
  turns: number;
  /** The wait now running, in ms. The rail's fill is animated over exactly this. */
  delayMs: number;
  /**
   * The turn has been asked for and the week has not arrived yet. The rail says so — a
   * bar that has finished filling and a calendar that has not moved would otherwise read
   * as the gesture having failed.
   */
  waiting: boolean;
}
