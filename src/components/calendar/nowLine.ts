/**
 * Where the current-time mark sits on the hour axis, and which hour label it has to take away to get
 * there. Pure: the clock is an argument, so the rule is testable without waiting for a minute to pass.
 */

import { labelBox, type AxisTick, type Timeline } from './geometry';

export interface NowLineInput {
  enabled: boolean;
  /** Minutes from midnight. */
  nowMinutes: number;
  timeline: Timeline;
  ticks: readonly AxisTick[];
}

export interface NowLinePlacement {
  /** Pixels from the top of the axis. */
  y: number;
  /** The label the mark would be drawn through, which the axis must leave unprinted. */
  hiddenTickMinutes: number | null;
}

export function nowLinePlacement(input: NowLineInput): NowLinePlacement | null {
  const { enabled, nowMinutes, timeline, ticks } = input;
  if (!enabled) return null;
  // `yOf` CLAMPS, so an hour outside the axis would otherwise pin the mark to an end of it and
  // claim a time that is not what the clock says.
  if (nowMinutes < timeline.startMinutes || nowMinutes > timeline.endMinutes) return null;

  const y = timeline.yOf(nowMinutes);
  return { y, hiddenTickMinutes: tickUnder(y, ticks, timeline) };
}

/** The gutter is 58px wide and its labels are right-aligned in it, so a mark crossing one lands on
 *  the text rather than beside it. The label gives way — measured the way `axisTicks` measures a
 *  collision between two labels, so the two never disagree about what overlapping means. */
function tickUnder(y: number, ticks: readonly AxisTick[], timeline: Timeline): number | null {
  for (const tick of ticks) {
    const box = labelBox(tick.minutes, timeline);
    if (y >= box.top && y <= box.bottom) return tick.minutes;
  }
  return null;
}

/**
 * Milliseconds until the wall clock turns over to the next minute. The mark is redrawn on that edge
 * rather than every 60 s from an arbitrary start, or it would sit up to a minute behind the labels.
 */
export function msUntilNextMinute(now: Date): number {
  return 60_000 - (now.getSeconds() * 1_000 + now.getMilliseconds());
}
