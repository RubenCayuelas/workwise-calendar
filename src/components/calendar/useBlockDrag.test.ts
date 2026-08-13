/**
 * A gesture ends where it was released — pinned.
 *
 * These cases are the owner's own report, «a veces no se coloca exactamente donde
 * quiero», reduced to its arithmetic. The defect was never in the conversion (`durationTo`
 * has always answered 6 h for 10:00 -> 17:30); it was that the AXIS the pointer was read
 * against changed BETWEEN THE PRESS AND THE RELEASE. The drag's own preview swapped the
 * two-line legend under the grid for a one-line hint, `.gridArea` grew by the 9.2 px the
 * legend gave up, the timeline re-fitted from 742 px to 751 px about 50 ms in, and the
 * pixel the owner released on was converted at a scale that had not existed when they
 * pressed: 17:30 read as 17:22 and committed 5,75 h.
 *
 * So every case here does the same thing: it hands the press a `pressAxis`, then hands
 * the pointer events an `options.timeline` that has ALREADY RE-FITTED, and demands the
 * answer the press axis gives. The release pixel is never a literal — it is
 * `metrics.top + pressAxis.yOf(target)`, read off the same geometry the grid paints
 * from, so a future change to the scale or to the axis cannot leave these numbers behind.
 *
 * The two heights are measurements from the running app on 2026-08-13 (1646x963, the
 * shop's window): 742 px at rest, 751 px with the drag hint published.
 */

import { describe, expect, it } from 'vitest';
import { manualWindowsOf } from '../../lib/manualWindow';
import type { DayShape, WorkPeriod } from '../../types';
import type { WeekDay } from '../../lib/api-client';
import { SNAP_MINUTES, createTimeline, type GridMetrics, type Timeline } from './geometry';
import { previewMove, previewResize, type DragSession, type DragTarget } from './useBlockDrag';

const MORNING: WorkPeriod = { startMinutes: 8 * 60, endMinutes: 14 * 60 };
const AFTERNOON: WorkPeriod = { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 };

/** The documented default shift, one hour of margin at each end: the axis is 07:00-20:30. */
const SHAPE: DayShape = {
  periods: [MORNING, AFTERNOON],
  manualWindows: manualWindowsOf([MORNING, AFTERNOON], 60, 60),
  shiftMinutes: 600,
  capacityMinutes: 600,
  marginTopMinutes: 60,
  marginBottomMinutes: 60,
  timelineStartMinutes: 7 * 60,
  timelineEndMinutes: 20 * 60 + 30,
};

/** The axis at rest, and the axis the legend's collapse produced mid-drag. */
const PRESS_AXIS = createTimeline(SHAPE, { fitHeight: 742 });
const REFITTED_AXIS = createTimeline(SHAPE, { fitHeight: 751 });

/** The grid's origin, as `measure()` reads it: unchanged by a re-fit (measured). */
const TOP = 152.5;
const METRICS: GridMetrics = {
  top: TOP,
  columns: [
    { date: '2026-08-13', left: 200, width: 180 },
    { date: '2026-08-15', left: 380, width: 180 },
  ],
};

const THURSDAY: WeekDay = day('2026-08-13', { role: 'auto' });
/** The weekend keeps the exact minute a drop asks for, so an error there is stored. */
const SATURDAY: WeekDay = day('2026-08-15', { role: 'manual', isWeekend: true });

function day(date: string, over: Partial<WeekDay>): WeekDay {
  return {
    date,
    weekday: 4,
    role: 'auto',
    isClosed: false,
    isWeekend: false,
    isToday: false,
    isPast: false,
    periods: [MORNING, AFTERNOON],
    manualWindows: [...SHAPE.manualWindows],
    capacityMinutes: 600,
    plannableMinutes: 600,
    bookedMinutes: 0,
    ...over,
  };
}

const dayAt = (date: string): WeekDay | undefined =>
  [THURSDAY, SATURDAY].find((candidate) => candidate.date === date);

/** `Reja`, the 4 h row of the report: Thursday 10:00-14:00. */
function target(over: Partial<DragTarget> = {}): DragTarget {
  return {
    groupId: 'reja',
    projectId: 'p-reja',
    name: 'Reja',
    color: '#1D9E75',
    date: '2026-08-13',
    startMinutes: 10 * 60,
    durationMinutes: 4 * 60,
    blockIds: ['reja'],
    blockId: 'reja',
    locked: false,
    ...over,
  };
}

/** The pointer goes down at `pressMinutes`, on the axis as it stands at that moment. */
function press(
  kind: 'move' | 'resize',
  pressMinutes: number,
  axis: Timeline = PRESS_AXIS,
  over: Partial<DragTarget> = {},
): DragSession {
  const dragTarget = target(over);
  return {
    kind,
    target: dragTarget,
    timeline: axis,
    originX: 260,
    originY: TOP + axis.yOf(pressMinutes),
    grabOffsetMinutes: kind === 'move' ? pressMinutes - dragTarget.startMinutes : 0,
    moved: true,
    exactMinutes: pressMinutes,
    preview: null,
  };
}

/** The client Y of a minute, as the grid draws it. How the release point is chosen. */
const yOf = (minutes: number, axis: Timeline = PRESS_AXIS): number => TOP + axis.yOf(minutes);

describe('previewResize', () => {
  it("commits the owner's worked example: 10:00 released on 17:30 is 6 h", () => {
    const session = press('resize', 14 * 60);
    const preview = previewResize({ clientY: yOf(17 * 60 + 30) }, session, METRICS, { dayAt });

    // 10:00-14:00 plus 15:30-17:30; the lunch break costs nothing.
    expect(preview.durationMinutes).toBe(360);
  });

  it('holds that answer when the axis re-fits between the press and the release', () => {
    // Exactly the legend's collapse: the gesture published a preview, the grid grew by
    // 9 px, and every later pointer event arrives with the new scale in `options`.
    const session = press('resize', 14 * 60, PRESS_AXIS);
    const preview = previewResize({ clientY: yOf(17 * 60 + 30) }, session, METRICS, { dayAt });

    expect(preview.durationMinutes).toBe(360);
    // The re-fitted axis would have read that same pixel as 17:22 and answered 5,75 h —
    // one SNAP_MINUTES short. This is the number the owner was shown before the fix.
    expect(REFITTED_AXIS.minutesAt(yOf(17 * 60 + 30) - TOP)).toBeLessThan(17 * 60 + 30);
    expect(previewResize({ clientY: yOf(17 * 60 + 30) }, press('resize', 14 * 60, REFITTED_AXIS), METRICS, { dayAt }).durationMinutes).toBe(360 - SNAP_MINUTES);
  });

  /**
   * The whole day, one row per release point: the top of the day, either side of the
   * lunch break, inside it, and the very last minute of the bottom margin. `requested` is
   * net working minutes from 10:00 — the lunch band contributes nothing, which is why
   * 14:00 and 15:00 ask for the same 4 h.
   */
  it.each([
    { release: 10 * 60 + 45, requested: 45 },
    { release: 11 * 60 + 45, requested: 105 },
    { release: 13 * 60, requested: 180 },
    { release: 14 * 60, requested: 240 },
    { release: 15 * 60, requested: 240 }, // inside the grey band: a dead zone, not a jump
    { release: 16 * 60, requested: 270 },
    { release: 17 * 60, requested: 330 },
    { release: 17 * 60 + 30, requested: 360 },
    { release: 18 * 60 + 30, requested: 420 },
    { release: 19 * 60 + 30, requested: 480 },
    { release: 20 * 60 + 15, requested: 525 }, // into the bottom margin, which is hand time
  ])('released on $release commits $requested minutes', ({ release, requested }) => {
    const session = press('resize', 14 * 60);
    expect(previewResize({ clientY: yOf(release) }, session, METRICS, { dayAt }).durationMinutes).toBe(
      requested,
    );
  });
});

describe('previewMove', () => {
  it('keeps the start when the pointer has not travelled at all', () => {
    // The honest answer to "grabbed here, released on the same pixel" is "it did not
    // move". With the axis re-derived per event it was not: the grab offset cancels an
    // ORIGIN error, and this is a SCALE error, so a still hand drifted by nine minutes —
    // and on the weekend, where the exact minute is kept rather than re-flowed, that
    // drift was STORED as a quarter of an hour.
    const grab = 19 * 60 + 10;
    const session = press('move', grab, PRESS_AXIS, { startMinutes: 15 * 60 + 30, durationMinutes: 240 });
    const preview = previewMove({ clientX: 460, clientY: yOf(grab) }, session, METRICS, { dayAt });

    expect(preview.date).toBe('2026-08-15');
    expect(preview.startMinutes).toBe(15 * 60 + 30);
  });

  it('lands a move on the minute the pointer was released on', () => {
    // Grabbed 30 min into a 09:00 row and released with that grab point on 12:20: the
    // row starts at 11:50, which snaps to 11:45.
    const session = press('move', 9 * 60 + 30, PRESS_AXIS, {
      startMinutes: 9 * 60,
      durationMinutes: 120,
    });
    const preview = previewMove({ clientX: 260, clientY: yOf(12 * 60 + 20) }, session, METRICS, { dayAt });

    expect(preview.date).toBe('2026-08-13');
    expect(preview.startMinutes).toBe(11 * 60 + 45);
  });

  it('follows the grid when the grid itself moves under a still hand', () => {
    // The other half of the promise, and the reason `measure()` stays live: a scroll (or
    // a banner opening above the grid) means the MINUTE UNDER THE POINTER really did
    // change, even though the hand did not move. Only the SCALE is fixed at press.
    const session = press('move', 9 * 60 + 30, PRESS_AXIS, {
      startMinutes: 9 * 60,
      durationMinutes: 120,
    });
    const scrolled: GridMetrics = { ...METRICS, top: TOP - PRESS_AXIS.yOf(10 * 60) + PRESS_AXIS.yOf(9 * 60) };
    const preview = previewMove({ clientX: 260, clientY: yOf(9 * 60 + 30) }, session, METRICS, { dayAt });
    const afterScroll = previewMove({ clientX: 260, clientY: yOf(9 * 60 + 30) }, session, scrolled, {
      dayAt,
    });

    expect(preview.startMinutes).toBe(9 * 60);
    expect(afterScroll.startMinutes).toBe(10 * 60);
  });
});
