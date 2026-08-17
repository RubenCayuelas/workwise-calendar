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
import type { AimRow } from './dropAim';
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
  // The visible box the edge zones are measured from, and the strips at its two ends: the
  // time-axis gutter on the left, the minimum on the right. These cases press at x=260 and
  // never go near either strip, so no page turn is ever in play here.
  frame: { left: 142, right: 560, leftZone: 58, rightZone: 40 },
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

/**
 * What the two previews need of the week: the day under the pointer, the week in order
 * (a release below the end of a day resolves to another column), and the rows a drop is
 * aimed against. These cases are about the AXIS, so the calendar under them is empty and
 * the aim is left exactly where the pointer put it — thirds have their own file.
 */
const OPTIONS = {
  dayAt,
  days: (): readonly WeekDay[] => [THURSDAY, SATURDAY],
  rowsOn: (): readonly AimRow[] => [],
};

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
    // Past the click slop: these cases are all real drags, never a shaky click.
    travelled: 40,
    preview: null,
    // The edge state of a drag that has never been near an edge: nothing remembered, the
    // zones armed (the press was in the middle of the grid), nothing counting down.
    point: null,
    edgeArmed: true,
    edge: null,
  };
}

/** The client Y of a minute, as the grid draws it. How the release point is chosen. */
const yOf = (minutes: number, axis: Timeline = PRESS_AXIS): number => TOP + axis.yOf(minutes);

describe('previewResize', () => {
  it("commits the owner's worked example: 10:00 released on 17:30 is 6 h", () => {
    const session = press('resize', 14 * 60);
    const preview = previewResize({ clientY: yOf(17 * 60 + 30) }, session, METRICS, OPTIONS);

    // 10:00-14:00 plus 15:30-17:30; the lunch break costs nothing.
    expect(preview.durationMinutes).toBe(360);
  });

  it('holds that answer when the axis re-fits between the press and the release', () => {
    // Exactly the legend's collapse: the gesture published a preview, the grid grew by
    // 9 px, and every later pointer event arrives with the new scale in `options`.
    const session = press('resize', 14 * 60, PRESS_AXIS);
    const preview = previewResize({ clientY: yOf(17 * 60 + 30) }, session, METRICS, OPTIONS);

    expect(preview.durationMinutes).toBe(360);
    // The re-fitted axis still reads that pixel as an earlier minute — the whole defect.
    expect(REFITTED_AXIS.minutesAt(yOf(17 * 60 + 30) - TOP)).toBeLessThan(17 * 60 + 30);
    /*
     * AND FARTHER DOWN THE COLUMN THE DRIFT IS STILL WORTH A WHOLE QUARTER OF AN HOUR.
     * The release point moved here on 2026-08-17, when the axis began compressing the
     * lunch band: the drift accumulates over WORKING pixels, so at 17:30 it is now 6.7
     * minutes and snaps back onto its own quarter, while at 19:30 it is 8 and does not.
     * The defect is the same one and so is its shape — a pixel converted at a scale that
     * did not exist when the owner pressed — only the depth at which it bites has moved.
     * 19:30 reads as 19:22 and commits 7,75 h for a gesture that drew 8 h.
     */
    expect(REFITTED_AXIS.minutesAt(yOf(19 * 60 + 30) - TOP)).toBe(19 * 60 + 22);
    expect(previewResize({ clientY: yOf(19 * 60 + 30) }, press('resize', 14 * 60, REFITTED_AXIS), METRICS, OPTIONS).durationMinutes).toBe(480 - SNAP_MINUTES);
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
    expect(previewResize({ clientY: yOf(release) }, session, METRICS, OPTIONS).durationMinutes).toBe(
      requested,
    );
  });
});

/**
 * INVARIANT 3, in the drag layer: the ghost may never promise a row that runs past the
 * end of the day, because the server stores what the ghost drew.
 *
 * The bottom margin set to 0 under a row that is already in it is the one shape CLAUDE.md
 * says legitimately survives ("what the owner loses is the margin as a TARGET, not the
 * hours already in it"), and the axis is widened by `cover` so the row stays visible. That
 * widening used to BE the cap: `reachableRuns` closed the last hole at `timeline.endMinutes`,
 * so the drag could grow the row into the very space the row's own overrun had created.
 */
describe('previewResize past the end of the day', () => {
  const NO_BOTTOM_MARGIN: DayShape = {
    ...SHAPE,
    marginBottomMinutes: 0,
    manualWindows: manualWindowsOf([MORNING, AFTERNOON], 60, 0),
  };
  const STRANDED: WeekDay = day('2026-08-13', {
    manualWindows: [...NO_BOTTOM_MARGIN.manualWindows],
  });
  // The axis the grid really paints in that state: widened to the containing hour so the
  // 19:30-20:30 row is not clipped.
  const WIDENED = createTimeline(NO_BOTTOM_MARGIN, { fitHeight: 742, cover: [20 * 60 + 30] });

  it('caps a growing row at the end of the day, not at the end of the axis', () => {
    const session = press('resize', 19 * 60 + 30, PRESS_AXIS, {
      startMinutes: 15 * 60 + 30,
      durationMinutes: 240,
    });
    // Released below the last rule the grid draws: 20:30 is the answer, twice over.
    expect(previewResize({ clientY: yOf(22 * 60) }, session, METRICS, OPTIONS).durationMinutes).toBe(300);
    expect(previewResize({ clientY: yOf(20 * 60 + 30) }, session, METRICS, OPTIONS).durationMinutes).toBe(300);
  });

  it('will not grow a row that already sits outside the windows, and keeps its length', () => {
    const strandedAt = (date: string): WeekDay | undefined => (date === '2026-08-13' ? STRANDED : undefined);
    const stranded = { ...OPTIONS, dayAt: strandedAt, days: () => [STRANDED] };
    const session = press('resize', 20 * 60 + 30, WIDENED, {
      startMinutes: 19 * 60 + 30,
      durationMinutes: 60,
    });
    const releaseY = (minutes: number): number => TOP + WIDENED.yOf(minutes);

    // Dragged to the bottom of the widened axis: the row stays the hour it is.
    expect(
      previewResize({ clientY: releaseY(21 * 60) }, session, METRICS, stranded).durationMinutes,
    ).toBe(60);
    // And it can still be shortened, which is the way back inside the day.
    expect(
      previewResize({ clientY: releaseY(20 * 60) }, session, METRICS, stranded).durationMinutes,
    ).toBe(30);
  });
});

describe('previewMove', () => {
  /**
   * The clamp that keeps a dropped unit inside the day. It used to be
   * `axisEnd − durationMinutes`, which mixes NET working minutes with CLOCK minutes: a 6 h
   * unit was allowed to start at 13:15, where it needs 7 h 30 of clock, and the server
   * stored `13:15-14:00` + `15:30-20:45` — a quarter of an hour past the end of the day.
   */
  it.each([
    { release: 13 * 60 + 15, start: 13 * 60 },
    { release: 13 * 60 + 30, start: 13 * 60 },
    { release: 13 * 60 + 45, start: 13 * 60 },
    { release: 12 * 60 + 45, start: 12 * 60 + 45 },
    { release: 13 * 60, start: 13 * 60 },
  ])('a 6 h unit released at $release starts at $start', ({ release, start }) => {
    const session = press('move', 13 * 60, PRESS_AXIS, {
      date: '2026-08-15',
      startMinutes: 8 * 60,
      durationMinutes: 360,
    });
    session.grabOffsetMinutes = 0;
    const preview = previewMove({ clientX: 460, clientY: yOf(release) }, session, METRICS, OPTIONS);
    expect(preview.startMinutes).toBe(start);
  });

  it('leaves a 10 h unit no later than 09:00, whatever the release point', () => {
    const session = press('move', 8 * 60, PRESS_AXIS, {
      date: '2026-08-15',
      startMinutes: 8 * 60,
      durationMinutes: 600,
    });
    session.grabOffsetMinutes = 0;
    for (const release of [10 * 60, 12 * 60, 13 * 60, 19 * 60]) {
      expect(
        previewMove({ clientX: 460, clientY: yOf(release) }, session, METRICS, OPTIONS).startMinutes,
        `released at ${release}`,
      ).toBe(9 * 60);
    }
  });

  it('still lets a drop start inside the lunch band, where the row is stored uncut', () => {
    // An Open Decision in CLAUDE.md, deliberately untouched: 6 h released at 14:00 is one
    // 14:00-20:00 row, which ends inside the day.
    const session = press('move', 14 * 60, PRESS_AXIS, {
      date: '2026-08-15',
      startMinutes: 8 * 60,
      durationMinutes: 360,
    });
    session.grabOffsetMinutes = 0;
    for (const release of [14 * 60, 14 * 60 + 15, 14 * 60 + 30]) {
      expect(
        previewMove({ clientX: 460, clientY: yOf(release) }, session, METRICS, OPTIONS).startMinutes,
        `released at ${release}`,
      ).toBe(release);
    }
  });

  it('keeps the start when the pointer has not travelled at all', () => {
    // The honest answer to "grabbed here, released on the same pixel" is "it did not
    // move". With the axis re-derived per event it was not: the grab offset cancels an
    // ORIGIN error, and this is a SCALE error, so a still hand drifted by nine minutes —
    // and on the weekend, where the exact minute is kept rather than re-flowed, that
    // drift was STORED as a quarter of an hour.
    const grab = 19 * 60 + 10;
    const session = press('move', grab, PRESS_AXIS, { startMinutes: 15 * 60 + 30, durationMinutes: 240 });
    const preview = previewMove({ clientX: 460, clientY: yOf(grab) }, session, METRICS, OPTIONS);

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
    const preview = previewMove({ clientX: 260, clientY: yOf(12 * 60 + 20) }, session, METRICS, OPTIONS);

    expect(preview.date).toBe('2026-08-13');
    expect(preview.startMinutes).toBe(11 * 60 + 45);
  });

  /**
   * WHAT THE GHOST IS ALLOWED TO PROMISE, which is the whole difference between the two
   * ways it is drawn. `pinned` says the row keeps the minute it was released on, so the
   * clock range is a promise; without it the release is only a queue rank.
   *
   * The case that was wrong: a drop into a MARGIN or the lunch band is stored exactly as
   * released on every day, Monday included (`pinsTheRow`, src/lib/operations/blocks.ts) —
   * the engine's index space has no margin minutes in it. Read off the day alone, the ghost
   * drew those as an insertion point and the hint promised a re-flow, while the server was
   * storing them padlocked.
   */
  describe('pinned', () => {
    const moveTo = (date: string, release: number, over: Partial<DragTarget> = {}) => {
      const session = press('move', 8 * 60, PRESS_AXIS, { date, startMinutes: 8 * 60, ...over });
      session.grabOffsetMinutes = 0;
      return previewMove(
        { clientX: date === '2026-08-13' ? 260 : 460, clientY: yOf(release) },
        session,
        METRICS,
        OPTIONS,
      );
    };

    it('is false inside the working periods of a day the engine reflows', () => {
      expect(moveTo('2026-08-13', 10 * 60, { durationMinutes: 120 }).pinned).toBe(false);
    });

    it('is true in the top margin of that same day', () => {
      // 07:15 + 2 h: an hour of it is margin, which the engine cannot represent.
      expect(moveTo('2026-08-13', 7 * 60 + 15, { durationMinutes: 120 }).pinned).toBe(true);
    });

    it('is true when the unit is long enough to reach the bottom margin', () => {
      // 6 h from 13:00 is 13:00-14:00 plus 15:30-20:30, and the last hour of that is margin.
      expect(moveTo('2026-08-13', 13 * 60, { durationMinutes: 360 }).pinned).toBe(true);
    });

    it('is true on the weekend, wherever the release lands', () => {
      expect(moveTo('2026-08-15', 10 * 60, { durationMinutes: 120 }).pinned).toBe(true);
    });

    it('is true for a locked unit on a day the engine reflows', () => {
      expect(moveTo('2026-08-13', 10 * 60, { durationMinutes: 120, locked: true }).pinned).toBe(true);
    });
  });

  /**
   * The ghost stops following the pointer at the last minute the unit can start on and still
   * end inside the day — a real rule (an unclamped rank comes back 409 `row-past-day-end`),
   * and one the owner cannot see. `clamped` is what lets the preview say it out loud instead
   * of freezing in silence for the last third of the column.
   */
  describe('clamped', () => {
    const releaseAt = (release: number, durationMinutes: number) => {
      const session = press('move', 8 * 60, PRESS_AXIS, {
        date: '2026-08-13',
        startMinutes: 8 * 60,
        durationMinutes,
      });
      session.grabOffsetMinutes = 0;
      return previewMove({ clientX: 260, clientY: yOf(release) }, session, METRICS, OPTIONS);
    };

    it('is not set while the ghost is still under the pointer', () => {
      expect(releaseAt(11 * 60, 360).clamped).toBe(false);
      expect(releaseAt(13 * 60, 360).clamped).toBe(false);
    });

    it('is set once the release is below the last start that fits the day', () => {
      const preview = releaseAt(18 * 60, 360);
      expect(preview.startMinutes).toBe(13 * 60);
      expect(preview.clamped).toBe(true);
    });

    it('is not set for a release above the axis, which is the edge of the screen', () => {
      expect(releaseAt(6 * 60, 120).clamped).toBe(false);
    });
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
    const preview = previewMove({ clientX: 260, clientY: yOf(9 * 60 + 30) }, session, METRICS, OPTIONS);
    const afterScroll = previewMove({ clientX: 260, clientY: yOf(9 * 60 + 30) }, session, scrolled, OPTIONS);

    expect(preview.startMinutes).toBe(9 * 60);
    expect(afterScroll.startMinutes).toBe(10 * 60);
  });
});

/**
 * THE TWO RULES THAT DECIDE WHERE A RELEASE REALLY GOES, seen through the preview the
 * owner watches while the pointer is still down. Their own arithmetic is pinned in
 * dropAim.test.ts; what these cases add is that the GESTURE asks them, and in what order.
 */
describe('previewMove — the aim and the day', () => {
  /** Friday, the colchón: the next day the engine would use after Thursday. */
  const FRIDAY: WeekDay = day('2026-08-14', { role: 'buffer', weekday: 5 });
  const WEEK = [THURSDAY, FRIDAY, SATURDAY];

  const optionsWith = (rows: readonly AimRow[]) => ({
    dayAt: (date: string): WeekDay | undefined => WEEK.find((candidate) => candidate.date === date),
    days: (): readonly WeekDay[] => WEEK,
    rowsOn: (): readonly AimRow[] => rows,
  });

  const releaseOn = (release: number, durationMinutes: number, rows: readonly AimRow[] = []) => {
    const session = press('move', 8 * 60, PRESS_AXIS, {
      date: '2026-08-13',
      startMinutes: 8 * 60,
      durationMinutes,
    });
    session.grabOffsetMinutes = 0;
    return previewMove({ clientX: 260, clientY: yOf(release) }, session, METRICS, optionsWith(rows));
  };

  it('moves a release the day cannot hold to the next day, at its first period', () => {
    // 6 h aimed at 18:00 on Thursday: the day ends at 20:30. The owner on the old answer
    // (refuse it, freeze the ghost): «Pasa al siguiente día. ¿Sabes cómo funciona un
    // calendario?»
    const preview = releaseOn(18 * 60, 360);
    expect(preview.date).toBe('2026-08-14');
    expect(preview.startMinutes).toBe(8 * 60);
    expect(preview.rolled).toBe(true);
    expect(preview.clamped).toBe(false);
  });

  it('stays on the day while what is aimed at still fits it', () => {
    const preview = releaseOn(18 * 60, 60);
    expect(preview.date).toBe('2026-08-13');
    expect(preview.startMinutes).toBe(18 * 60);
    expect(preview.rolled).toBe(false);
  });

  it('quantises the aim against the row under it before asking about the day', () => {
    // `Alfa` 09:00-13:00: the middle third of it means "cut it", at its own midpoint,
    // whichever quarter of an hour inside that third the hand happens to be over.
    const alfa: AimRow = { id: 'alfa', startMinutes: 9 * 60, durationMinutes: 240 };
    expect(releaseOn(10 * 60 + 30, 120, [alfa]).startMinutes).toBe(11 * 60);
    expect(releaseOn(11 * 60 + 30, 120, [alfa]).startMinutes).toBe(11 * 60);
    // Its upper third means "before it", so the aim is the row's own start.
    expect(releaseOn(9 * 60 + 45, 120, [alfa]).startMinutes).toBe(9 * 60);
    // Its lower third means "after it".
    expect(releaseOn(12 * 60 + 30, 120, [alfa]).startMinutes).toBe(13 * 60);
  });
});

/**
 * THE WEEK CHANGED UNDER THE POINTER — the block was held at an edge, the calendar paged,
 * and the columns the drag is resolved against are now another week's.
 *
 * The gesture is fixed to the axis it pressed on and that must not change; everything
 * HORIZONTAL must. The one thing that could have remembered the old week is the date the
 * preview falls back to when the pointer is over no column at all, which is exactly where
 * the left-hand edge zone is: the time-axis gutter.
 */
describe('previewMove after the week has paged', () => {
  const NEXT_WEEK_THURSDAY: WeekDay = day('2026-08-20', { role: 'auto' });
  const NEXT_WEEK_SATURDAY: WeekDay = day('2026-08-22', { role: 'manual', isWeekend: true });
  const PAGED = [NEXT_WEEK_THURSDAY, NEXT_WEEK_SATURDAY];

  /** The same grid, one week on: same boxes, new dates. Paging changes only the labels. */
  const PAGED_METRICS: GridMetrics = {
    ...METRICS,
    columns: [
      { date: '2026-08-20', left: 200, width: 180 },
      { date: '2026-08-22', left: 380, width: 180 },
    ],
  };

  const pagedOptions = {
    dayAt: (date: string): WeekDay | undefined => PAGED.find((candidate) => candidate.date === date),
    days: (): readonly WeekDay[] => PAGED,
    rowsOn: (): readonly AimRow[] => [],
  };

  /** A drag that began on last week's Thursday and has a preview from that week. */
  function paging(): DragSession {
    const session = press('move', 10 * 60);
    session.grabOffsetMinutes = 0;
    session.preview = {
      kind: 'move',
      groupId: 'reja',
      color: '#1D9E75',
      date: '2026-08-13',
      startMinutes: 10 * 60,
      durationMinutes: 240,
      allowed: true,
    };
    return session;
  }

  it('lands on the new week when the pointer is over a column', () => {
    const preview = previewMove(
      { clientX: 260, clientY: yOf(10 * 60) },
      paging(),
      PAGED_METRICS,
      pagedOptions,
    );
    expect(preview.date).toBe('2026-08-20');
    expect(preview.allowed).toBe(true);
  });

  it('falls back to the nearest column, not to the day it remembers from last week', () => {
    // x = 60 is the time-axis gutter — the left edge zone, where the pointer sits while it
    // is paging. Kept, `2026-08-13` would be a date no column carries: the ghost would be
    // drawn nowhere and the drop resolved against a day `dayAt` cannot find.
    const preview = previewMove(
      { clientX: 60, clientY: yOf(10 * 60) },
      paging(),
      PAGED_METRICS,
      pagedOptions,
    );
    expect(preview.date).toBe('2026-08-20');
    expect(preview.allowed).toBe(true);
  });

  it('keeps the remembered column while it is still on screen', () => {
    // The behaviour that was there before paging existed, and the reason the fallback is
    // not simply "nearest": leaving the grid sideways keeps the column the drag was over.
    const preview = previewMove(
      { clientX: 60, clientY: yOf(10 * 60) },
      paging(),
      METRICS,
      OPTIONS,
    );
    expect(preview.date).toBe('2026-08-13');
  });
});
